/* ============================================================================
   Wakefield Fluid — a real Navier-Stokes solver running in the browser.

   Every frame the GPU actually solves the incompressible Navier-Stokes
   equations on a grid (Stam 1999 "Stable Fluids", GPU Gems ch.38):

     1. advect velocity      semi-Lagrangian backtrace
     2. apply solid mask     v = v_body inside the model
     3. apply inflow mask    v = U at the tunnel inlet
     4. curl                 w = curl(v)
     5. vorticity confinement re-inject the small-scale swirl numerics ate
     6. divergence           div(v)
     7. pressure             Jacobi iterations (incompressibility)
     8. projection           v -= grad(p)
     9. advect dye           the visible smoke / foam

   The model silhouette is rasterised into the field as a solid, with
   reflected (no-penetration) velocity at its boundary — so the flow really
   separates around the shape and sheds a wake. Same maths family as the
   Taichi / GAMES201 stable-fluids demos.
   ========================================================================== */
(function (global) {
  'use strict';

  var CLAMP = 0x812F; /* GL_CLAMP_TO_EDGE */

  /* ------------------------------- context -------------------------------- */
  function getContext(canvas) {
    var params = { alpha: false, depth: false, stencil: false, antialias: false,
                   preserveDrawingBuffer: false, powerPreference: 'high-performance' };
    var gl = canvas.getContext('webgl2', params);
    var isWebGL2 = !!gl;
    if (!gl) gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);
    if (!gl) return null;

    var halfFloat, supportLinearFiltering;
    if (isWebGL2) {
      gl.getExtension('EXT_color_buffer_float');
      gl.getExtension('EXT_color_buffer_half_float');
      supportLinearFiltering = true;               /* 16F is filterable in WebGL2 */
      halfFloat = gl.HALF_FLOAT;
    } else {
      var hf = gl.getExtension('OES_texture_half_float');
      supportLinearFiltering = !!gl.getExtension('OES_texture_half_float_linear');
      gl.getExtension('EXT_color_buffer_half_float');
      gl.getExtension('WEBGL_color_buffer_float');
      halfFloat = hf ? hf.HALF_FLOAT_OES : gl.UNSIGNED_BYTE;
    }

    gl.clearColor(0, 0, 0, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    var formatRGBA, formatRG, formatR;
    if (isWebGL2) {
      formatRGBA = pick(gl, gl.RGBA16F, gl.RGBA, halfFloat);
      formatRG   = pick(gl, gl.RG16F,   gl.RG,   halfFloat);
      formatR    = pick(gl, gl.R16F,    gl.RED,  halfFloat);
    } else {
      formatRGBA = pick(gl, gl.RGBA, gl.RGBA, halfFloat);
      formatRG   = formatRGBA;
      formatR    = formatRGBA;
    }
    if (!formatRGBA) return null;

    return {
      gl: gl, isWebGL2: isWebGL2, halfFloatTexType: halfFloat,
      formatRGBA: formatRGBA, formatRG: formatRG, formatR: formatR,
      supportLinearFiltering: supportLinearFiltering
    };
  }

  /* try a format, degrade to a wider one if it cannot be rendered to */
  function pick(gl, internalFormat, format, type) {
    if (renderable(gl, internalFormat, format, type)) return { internalFormat: internalFormat, format: format };
    if (internalFormat === gl.R16F)    return pick(gl, gl.RG16F, gl.RG, type);
    if (internalFormat === gl.RG16F)   return pick(gl, gl.RGBA16F, gl.RGBA, type);
    return null;
  }

  function renderable(gl, internalFormat, format, type) {
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, CLAMP);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, CLAMP);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(texture);
    return ok;
  }

  /* -------------------------------- shaders ------------------------------- */
  var VERT = [
    'precision highp float;',
    'attribute vec2 aPosition;',
    'varying vec2 vUv, vL, vR, vT, vB;',
    'uniform vec2 texelSize;',
    'void main () {',
    '  vUv = aPosition * 0.5 + 0.5;',
    '  vL = vUv - vec2(texelSize.x, 0.0);',
    '  vR = vUv + vec2(texelSize.x, 0.0);',
    '  vT = vUv + vec2(0.0, texelSize.y);',
    '  vB = vUv - vec2(0.0, texelSize.y);',
    '  gl_Position = vec4(aPosition, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FRAG_HEAD = 'precision highp float;\nprecision highp sampler2D;\nvarying vec2 vUv, vL, vR, vT, vB;\n';

  var F_CLEAR = FRAG_HEAD + [
    'uniform sampler2D uTexture;',
    'uniform float value;',
    'void main () { gl_FragColor = value * texture2D(uTexture, vUv); }'
  ].join('\n');

  var F_SPLAT = FRAG_HEAD + [
    'uniform sampler2D uTarget;',
    'uniform float aspectRatio;',
    'uniform vec3 color;',
    'uniform vec2 point;',
    'uniform float radius;',
    'void main () {',
    '  vec2 p = vUv - point.xy;',
    '  p.x *= aspectRatio;',
    '  vec3 splat = exp(-dot(p, p) / radius) * color;',
    '  vec3 base = texture2D(uTarget, vUv).xyz;',
    '  gl_FragColor = vec4(base + splat, 1.0);',
    '}'
  ].join('\n');

  /* advection — plus a soft outflow fade on the downstream side so smoke/water
     leaves the tunnel instead of smearing against the far wall.              */
  var F_ADVECT = FRAG_HEAD + [
    'uniform sampler2D uVelocity;',
    'uniform sampler2D uSource;',
    'uniform vec2 texelSize;',
    'uniform float dt;',
    'uniform float dissipation;',
    'uniform float uFlowDir;',
    'void main () {',
    '  vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;',
    '  vec4 result = texture2D(uSource, coord);',
    '  result /= (1.0 + dissipation * dt);',
    '  float edge = uFlowDir > 0.0 ? smoothstep(1.0, 0.935, vUv.x) : smoothstep(0.0, 0.065, vUv.x);',
    '  result *= edge;',
    '  gl_FragColor = result;',
    '}'
  ].join('\n');

  /* boundary pass: pin inlet velocity, and make the model a moving solid */
  var F_BOUNDARY = FRAG_HEAD + [
    'uniform sampler2D uVelocity;',
    'uniform sampler2D uObstacle;',
    'uniform sampler2D uInflow;',
    'uniform vec2 uObstacleVel;',
    'uniform vec2 uInflowVel;',
    'void main () {',
    '  float o = texture2D(uObstacle, vUv).x;',
    '  float i = texture2D(uInflow, vUv).x;',
    '  vec2 v = texture2D(uVelocity, vUv).xy;',
    '  v = mix(v, uInflowVel, i);',
    '  v = mix(v, uObstacleVel, o);',
    '  gl_FragColor = vec4(v, 0.0, 1.0);',
    '}'
  ].join('\n');

  var F_DIVERGENCE = FRAG_HEAD + [
    'uniform sampler2D uVelocity;',
    'uniform sampler2D uObstacle;',
    'void main () {',
    '  vec2 C = texture2D(uVelocity, vUv).xy;',
    '  float oL = texture2D(uObstacle, vL).x;',
    '  float oR = texture2D(uObstacle, vR).x;',
    '  float oT = texture2D(uObstacle, vT).x;',
    '  float oB = texture2D(uObstacle, vB).x;',
    /* solid neighbour -> mirror the normal component: no penetration */
    '  float L = oL > 0.5 ? -C.x : texture2D(uVelocity, vL).x;',
    '  float R = oR > 0.5 ? -C.x : texture2D(uVelocity, vR).x;',
    '  float T = oT > 0.5 ? -C.y : texture2D(uVelocity, vT).y;',
    '  float B = oB > 0.5 ? -C.y : texture2D(uVelocity, vB).y;',
    '  float div = 0.5 * (R - L + T - B);',
    '  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var F_CURL = FRAG_HEAD + [
    'uniform sampler2D uVelocity;',
    'void main () {',
    '  float L = texture2D(uVelocity, vL).y;',
    '  float R = texture2D(uVelocity, vR).y;',
    '  float T = texture2D(uVelocity, vT).x;',
    '  float B = texture2D(uVelocity, vB).x;',
    '  gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var F_VORTICITY = FRAG_HEAD + [
    'uniform sampler2D uVelocity;',
    'uniform sampler2D uCurl;',
    'uniform float curl;',
    'uniform float dt;',
    'void main () {',
    '  float L = texture2D(uCurl, vL).x;',
    '  float R = texture2D(uCurl, vR).x;',
    '  float T = texture2D(uCurl, vT).x;',
    '  float B = texture2D(uCurl, vB).x;',
    '  float C = texture2D(uCurl, vUv).x;',
    '  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));',
    '  force /= length(force) + 0.0001;',
    '  force *= curl * C;',
    '  force.y *= -1.0;',
    '  vec2 vel = texture2D(uVelocity, vUv).xy;',
    '  vel += force * dt;',
    '  gl_FragColor = vec4(clamp(vel, -1200.0, 1200.0), 0.0, 1.0);',
    '}'
  ].join('\n');

  var F_PRESSURE = FRAG_HEAD + [
    'uniform sampler2D uPressure;',
    'uniform sampler2D uDivergence;',
    'uniform sampler2D uObstacle;',
    'uniform sampler2D uOpen;',
    'void main () {',
    /* the outlet is a pressure-free boundary, so the flow can exit */
    '  if (texture2D(uOpen, vUv).x > 0.5) { gl_FragColor = vec4(0.0); return; }',
    '  float oL = texture2D(uObstacle, vL).x;',
    '  float oR = texture2D(uObstacle, vR).x;',
    '  float oT = texture2D(uObstacle, vT).x;',
    '  float oB = texture2D(uObstacle, vB).x;',
    '  float C = texture2D(uPressure, vUv).x;',
    '  float L = oL > 0.5 ? C : texture2D(uPressure, vL).x;',
    '  float R = oR > 0.5 ? C : texture2D(uPressure, vR).x;',
    '  float T = oT > 0.5 ? C : texture2D(uPressure, vT).x;',
    '  float B = oB > 0.5 ? C : texture2D(uPressure, vB).x;',
    '  float div = texture2D(uDivergence, vUv).x;',
    '  gl_FragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var F_GRADIENT = FRAG_HEAD + [
    'uniform sampler2D uPressure;',
    'uniform sampler2D uVelocity;',
    'uniform sampler2D uObstacle;',
    'void main () {',
    '  float oL = texture2D(uObstacle, vL).x;',
    '  float oR = texture2D(uObstacle, vR).x;',
    '  float oT = texture2D(uObstacle, vT).x;',
    '  float oB = texture2D(uObstacle, vB).x;',
    '  float C = texture2D(uPressure, vUv).x;',
    '  float L = oL > 0.5 ? C : texture2D(uPressure, vL).x;',
    '  float R = oR > 0.5 ? C : texture2D(uPressure, vR).x;',
    '  float T = oT > 0.5 ? C : texture2D(uPressure, vT).x;',
    '  float B = oB > 0.5 ? C : texture2D(uPressure, vB).x;',
    '  vec2 v = texture2D(uVelocity, vUv).xy;',
    '  v -= vec2(R - L, T - B);',
    '  gl_FragColor = vec4(v, 0.0, 1.0);',
    '}'
  ].join('\n');

  var F_DISPLAY = FRAG_HEAD + [
    'uniform sampler2D uTexture;',
    'uniform sampler2D uObstacle;',
    'uniform sampler2D uSprite;',
    'uniform vec4 uSpriteRect;',
    'uniform vec2 texelSize;',
    'uniform vec3 uBgTop;',
    'uniform vec3 uBgBot;',
    'uniform float uWaterLine;',
    'uniform float uMode;',
    'uniform float uTime;',
    'void main () {',
    '  vec3 c = texture2D(uTexture, vUv).rgb;',
    '  float d = length(c);',
    /* fake normals from the dye gradient -> smoke gets volume */
    '  float ll = length(texture2D(uTexture, vL).rgb);',
    '  float lr = length(texture2D(uTexture, vR).rgb);',
    '  float lb = length(texture2D(uTexture, vB).rgb);',
    '  float lt = length(texture2D(uTexture, vT).rgb);',
    '  vec3 n = normalize(vec3(ll - lr, lb - lt, 0.30));',
    '  vec3 ld = normalize(vec3(-0.45, 0.65, 0.62));',
    '  float spec = pow(max(dot(n, ld), 0.0), 16.0);',
    '  float rim  = pow(1.0 - abs(n.z), 2.0);',
    '  vec3 col;',
    '  if (uMode > 0.5) {',
    /* ---- seaway: sky above the horizon, lit surface fading to deep below ---- */
    '    float wl = uWaterLine;',                                  /* y-up */
    '    float isSky = smoothstep(wl - 0.0015, wl + 0.0015, vUv.y);',
    '    vec3 sky = mix(vec3(0.155, 0.295, 0.395), vec3(0.035, 0.075, 0.135), smoothstep(wl, 1.05, vUv.y));',
    '    float depth = clamp((wl - vUv.y) / max(wl, 0.001), 0.0, 1.0);',
    '    vec3 sea = mix(vec3(0.100, 0.400, 0.500), vec3(0.012, 0.060, 0.110), pow(depth, 0.62));',
    /* swell: long bands scrolling with the current, strongest at the surface */
    '    float ph = uTime * 0.85;',
    '    float s1 = sin(vUv.x * 24.0 + ph * 1.25) * 0.5 + 0.5;',
    '    float s2 = sin(vUv.x * 37.0 - ph * 1.65 + 1.7) * 0.5 + 0.5;',
    '    float s3 = sin(vUv.x * 61.0 + ph * 2.10 + 4.0) * 0.5 + 0.5;',
    '    sea += vec3(0.055, 0.115, 0.125) * s1 * exp(-depth * 22.0);',
    '    sea += vec3(0.045, 0.095, 0.105) * s2 * exp(-depth * 38.0);',
    '    sea += vec3(0.035, 0.075, 0.085) * s3 * exp(-depth * 60.0);',
    /* moving glints follow the water surface instead of filling the sea
       with cloudy dye as the wind scenes do */
    '    float ripple = sin(vUv.x * 82.0 + sin(vUv.x * 24.0 - ph) * 2.0 - ph * 3.0);',
    '    ripple += sin(vUv.x * 113.0 + ph * 2.2) * 0.42;',
    '    sea += vec3(0.025, 0.080, 0.100) * max(ripple, 0.0) * exp(-depth * 24.0);',
    /* horizon glow where sky meets sea */
    '    float hor = exp(-pow((vUv.y - wl) * 130.0, 2.0));',
    '    col = mix(sea, sky, isSky) + vec3(0.100, 0.170, 0.200) * hor;',
    /* dye under the surface is tinted toward sea water, so the currents read
       as water and never as pale smoke; foam and spray at the line stay white */
    '    float dpt = clamp((wl - vUv.y) / 0.30, 0.0, 1.0);',
    '    c = mix(c, c * vec3(0.34, 0.80, 1.42), dpt);',
    '    float surfaceFlow = exp(-abs(vUv.y - wl) * 37.0);',
    '    col += c * 1.25 * surfaceFlow;',
    '    col += spec * d * 0.55 * surfaceFlow;',
    /* the ship's reflection: mirrored above the line, wobbling, fading with depth */
    '    if (uSpriteRect.w > 0.0 && vUv.y < wl) {',
    '      vec2 suv3 = (vUv - uSpriteRect.xy) / uSpriteRect.zw;',
    '      if (suv3.x > 0.0 && suv3.x < 1.0) {',
    '        float wob = sin(vUv.x * 70.0 + uTime * 2.4) * 0.5 + sin(vUv.x * 29.0 - uTime * 1.6) * 0.5;',
    '        float mirrorY = wl + (wl - vUv.y) * 1.12;',   /* world y-up */
    '        vec2 ruv = vec2(clamp(suv3.x + wob * 0.006, 0.0, 1.0),',
    '                        clamp((mirrorY - uSpriteRect.y) / uSpriteRect.w, 0.0, 1.0));',
    '        vec4 rsp = texture2D(uSprite, ruv);',
    '        float fade = exp(-(wl - vUv.y) * 11.0);',
    '        col = mix(col, mix(col, rsp.rgb, 0.60), rsp.a * fade * 0.40);',
    '      }',
    '    }',
    '  } else {',
    '    vec3 bg = mix(uBgBot, uBgTop, smoothstep(1.0, 0.0, vUv.y));',
    '    col = bg + c;',
    '    col += spec * d * 0.90 + rim * d * 0.25;',
    '  }',
    '  float obs = texture2D(uObstacle, vUv).x;',
    '  col = mix(col, col * 0.08 + vec3(0.045, 0.082, 0.130), obs * 0.94);',
    /* the real car sprite, drawn over the flow; a fraction of the dye is
       kept on top so smoke reads as passing in front of the body */
    '  vec2 sIn = step(uSpriteRect.xy, vUv) * step(vUv, uSpriteRect.xy + uSpriteRect.zw);',
    '  float sMask = sIn.x * sIn.y;',
    '  vec2 suv = clamp((vUv - uSpriteRect.xy) / uSpriteRect.zw, 0.0, 1.0);',
    '  vec4 sp = texture2D(uSprite, suv) * sMask;',
    '  col = mix(col, sp.rgb * 1.10, sp.a);',
    '  col += c * 0.22 * sp.a;',
    '  col = col / (col + vec3(0.55)) * 1.12;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /* ------------------------------ gl plumbing ----------------------------- */
  function compile(gl, type, source) {
    var s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      console.error('[wakefield] shader:', gl.getShaderInfoLog(s));
    return s;
  }

  function Program(gl, vsSrc, fsSrc) {
    var vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    var fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    var p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'aPosition');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      console.error('[wakefield] link:', gl.getProgramInfoLog(p));
    this.gl = gl; this.program = p; this.u = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var name = gl.getActiveUniform(p, i).name;
      this.u[name] = gl.getUniformLocation(p, name);
    }
  }
  Program.prototype.bind = function () { this.gl.useProgram(this.program); };

  function makeFBO(gl, w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, CLAMP);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, CLAMP);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture: texture, fbo: fbo, width: w, height: h,
      texelSizeX: 1 / w, texelSizeY: 1 / h,
      attach: function (id) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      }
    };
  }

  function makeDoubleFBO(gl, w, h, internalFormat, format, type, param) {
    var a = makeFBO(gl, w, h, internalFormat, format, type, param);
    var b = makeFBO(gl, w, h, internalFormat, format, type, param);
    return {
      width: w, height: h, texelSizeX: a.texelSizeX, texelSizeY: a.texelSizeY,
      get read() { return a; }, set read(v) { a = v; },
      get write() { return b; }, set write(v) { b = v; },
      swap: function () { var t = a; a = b; b = t; }
    };
  }

  function blit(gl, target) {
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  /* --------------------------- model silhouettes --------------------------
     Normalised 0..1 space. `op` is 'fill' when we rasterise the solid into the
     solver, 'stroke' when we draw the outline on the overlay canvas.        */

  /* real model sprite: a true 3D car (Ferrari 458, CC-BY, three.js example
     asset) rendered offline in an orthographic side view. Its alpha channel
     becomes the solid for the solver; its colour is composited over the flow. */
  var CAR_IMG_AR = 3.65;                              /* png width / height   */
  var CAR_RECT  = { x: 0.075, w: 0.76, bottomY: 0.775 }; /* canvas uv, y down */
  var CAR_MASK  = null;                               /* thresholded alpha    */

  function buildCarMask(img) {
    var cv = newCanvas(Math.round(img.width / 2), Math.round(img.height / 2));
    var ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    var d = ctx.getImageData(0, 0, cv.width, cv.height);
    var p = d.data;
    for (var i = 0; i < p.length; i += 4) {
      if (p[i + 3] > 110) { p[i] = 255; p[i + 1] = 255; p[i + 2] = 255; p[i + 3] = 255; }
      else { p[i + 3] = 0; }
    }
    ctx.putImageData(d, 0, 0);
    return cv;
  }

  /* real model sprite: a true 3D tall ship (Quaternius, public domain) rendered
     offline in an orthographic side view, bow right, sitting in the seaway.
     Same contract as the car: alpha -> solid for the solver, colour composited
     over the flow, plus a wobbling reflection under the waterline.            */
  var SHIP_IMG_AR = 1.656;                                /* png width / height  */
  var SHIP_RECT  = { x: 0.075, w: 0.85, bottomY: 0.62 };  /* canvas uv, y down   */
  var SHIP_MASK  = null;

  function buildShipMask(img) {
    var cv = newCanvas(Math.round(img.width / 2), Math.round(img.height / 2));
    var ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    var d = ctx.getImageData(0, 0, cv.width, cv.height);
    var p = d.data;
    for (var i = 0; i < p.length; i += 4) {
      if (p[i + 3] > 110) { p[i] = 255; p[i + 1] = 255; p[i + 2] = 255; p[i + 3] = 255; }
      else { p[i + 3] = 0; }
    }
    ctx.putImageData(d, 0, 0);
    return cv;
  }

  /* the ship is tall; on wide canvases the fitted rect would push the mast tips
     out of frame, so shrink (and recentre) until the top clears 3%            */
  function shipRectFor(aspect) {
    var w = SHIP_RECT.w;
    var hUv = w * aspect / SHIP_IMG_AR;
    var top = SHIP_RECT.bottomY - hUv * 0.985;
    if (top < 0.03) {
      var k = (SHIP_RECT.bottomY - 0.03) / (hUv * 0.985);
      w *= k;
    }
    return { x: SHIP_RECT.x + (SHIP_RECT.w - w) / 2, w: w, bottomY: SHIP_RECT.bottomY };
  }

  /* real model sprite: a CC0 regional jet (Innerscene library), nose left into
     the wind — same contract as the car and the ship. The GLB ships with a
     ground-shadow mesh; the bottom 92px were cropped off the render.          */
  var PLANE_IMG_AR = 4.5155;                               /* png width / height */
  var PLANE_RECT = { x: 0.075, w: 0.85, bottomY: 0.78 };   /* canvas uv, y down  */
  var PLANE_MASK = null;

  function buildPlaneMask(img) {
    var cv = newCanvas(Math.round(img.width / 2), Math.round(img.height / 2));
    var ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    var d = ctx.getImageData(0, 0, cv.width, cv.height);
    var p = d.data;
    for (var i = 0; i < p.length; i += 4) {
      if (p[i + 3] > 110) { p[i] = 255; p[i + 1] = 255; p[i + 2] = 255; p[i + 3] = 255; }
      else { p[i + 3] = 0; }
    }
    ctx.putImageData(d, 0, 0);
    return cv;
  }

  /* the fin is tall for the fuselage length; shrink on narrow canvases */
  function planeRectFor(aspect) {
    var w = PLANE_RECT.w;
    var hUv = w * aspect / PLANE_IMG_AR;
    var top = PLANE_RECT.bottomY - hUv * 0.985;
    if (top < 0.03) {
      var k = (PLANE_RECT.bottomY - 0.03) / (hUv * 0.985);
      w *= k;
    }
    return { x: PLANE_RECT.x + (PLANE_RECT.w - w) / 2, w: w, bottomY: PLANE_RECT.bottomY };
  }

  var SIL = {
    /* low-slung coupe, side view, nose left */
    car: function (ctx, W, H, op) {
      var X = function (v) { return v * W; }, Y = function (v) { return v * H; };
      ctx.beginPath();
      ctx.moveTo(X(0.075), Y(0.700));
      ctx.lineTo(X(0.088), Y(0.648));
      ctx.bezierCurveTo(X(0.130), Y(0.602), X(0.190), Y(0.578), X(0.255), Y(0.572));
      ctx.lineTo(X(0.335), Y(0.508));
      ctx.bezierCurveTo(X(0.400), Y(0.478), X(0.520), Y(0.478), X(0.585), Y(0.508));
      ctx.lineTo(X(0.705), Y(0.552));
      ctx.lineTo(X(0.800), Y(0.566));
      ctx.lineTo(X(0.878), Y(0.582));
      ctx.lineTo(X(0.922), Y(0.608));
      ctx.lineTo(X(0.935), Y(0.658));
      ctx.lineTo(X(0.935), Y(0.700));
      ctx.closePath();
      ctx[op]();
      /* wheels */
      [[0.255, 0.700, 0.070], [0.735, 0.700, 0.070]].forEach(function (w) {
        ctx.beginPath(); ctx.arc(X(w[0]), Y(w[1]), X(w[2]), 0, Math.PI * 2); ctx[op]();
      });
      /* rear wing */
      ctx.beginPath();
      ctx.moveTo(X(0.852), Y(0.560)); ctx.lineTo(X(0.930), Y(0.552));
      ctx.lineTo(X(0.940), Y(0.572)); ctx.lineTo(X(0.858), Y(0.580));
      ctx.closePath(); ctx[op]();
    },

    /* standing figure on a base — hair & sash are fluid-driven */
    figure: function (ctx, W, H, op) {
      var X = function (v) { return v * W; }, Y = function (v) { return v * H; };
      ctx.beginPath();
      ctx.ellipse(X(0.500), Y(0.865), X(0.150), Y(0.030), 0, 0, Math.PI * 2);
      ctx[op]();
      /* legs */
      ctx.beginPath();
      ctx.moveTo(X(0.468), Y(0.560)); ctx.lineTo(X(0.450), Y(0.700));
      ctx.lineTo(X(0.438), Y(0.842)); ctx.lineTo(X(0.492), Y(0.842));
      ctx.lineTo(X(0.500), Y(0.702)); ctx.lineTo(X(0.524), Y(0.842));
      ctx.lineTo(X(0.578), Y(0.842)); ctx.lineTo(X(0.550), Y(0.700));
      ctx.lineTo(X(0.534), Y(0.560)); ctx.closePath(); ctx[op]();
      /* torso */
      ctx.beginPath();
      ctx.moveTo(X(0.460), Y(0.332));
      ctx.bezierCurveTo(X(0.444), Y(0.402), X(0.450), Y(0.502), X(0.462), Y(0.568));
      ctx.lineTo(X(0.542), Y(0.568));
      ctx.bezierCurveTo(X(0.556), Y(0.502), X(0.560), Y(0.402), X(0.544), Y(0.332));
      ctx.closePath(); ctx[op]();
      /* arms */
      ctx.beginPath();
      ctx.moveTo(X(0.464), Y(0.354)); ctx.lineTo(X(0.410), Y(0.472));
      ctx.lineTo(X(0.396), Y(0.598)); ctx.lineTo(X(0.422), Y(0.602));
      ctx.lineTo(X(0.444), Y(0.480)); ctx.lineTo(X(0.486), Y(0.374));
      ctx.closePath(); ctx[op]();
      ctx.beginPath();
      ctx.moveTo(X(0.540), Y(0.354)); ctx.lineTo(X(0.598), Y(0.442));
      ctx.lineTo(X(0.642), Y(0.522)); ctx.lineTo(X(0.620), Y(0.538));
      ctx.lineTo(X(0.568), Y(0.468)); ctx.lineTo(X(0.520), Y(0.374));
      ctx.closePath(); ctx[op]();
      /* neck + head */
      ctx.beginPath(); ctx.rect(X(0.484), Y(0.296), X(0.034), Y(0.042)); ctx[op]();
      ctx.beginPath(); ctx.arc(X(0.500), Y(0.264), X(0.060), 0, Math.PI * 2); ctx[op]();
    },

    /* research vessel, side view, bow right */
    hull: function (ctx, W, H, op) {
      var X = function (v) { return v * W; }, Y = function (v) { return v * H; };
      /* hull */
      ctx.beginPath();
      ctx.moveTo(X(0.962), Y(0.522));
      ctx.bezierCurveTo(X(0.928), Y(0.562), X(0.878), Y(0.598), X(0.800), Y(0.610));
      ctx.lineTo(X(0.242), Y(0.612));
      ctx.bezierCurveTo(X(0.182), Y(0.606), X(0.150), Y(0.578), X(0.142), Y(0.540));
      ctx.lineTo(X(0.142), Y(0.464));
      ctx.lineTo(X(0.956), Y(0.464));
      ctx.closePath(); ctx[op]();
      /* deckhouse */
      ctx.beginPath();
      ctx.moveTo(X(0.298), Y(0.464)); ctx.lineTo(X(0.298), Y(0.374));
      ctx.lineTo(X(0.560), Y(0.374)); ctx.lineTo(X(0.560), Y(0.464));
      ctx.closePath(); ctx[op]();
      ctx.beginPath();
      ctx.moveTo(X(0.350), Y(0.374)); ctx.lineTo(X(0.350), Y(0.318));
      ctx.lineTo(X(0.472), Y(0.318)); ctx.lineTo(X(0.472), Y(0.374));
      ctx.closePath(); ctx[op]();
      /* funnel + mast + derrick */
      ctx.beginPath(); ctx.rect(X(0.384), Y(0.258), X(0.050), Y(0.062)); ctx[op]();
      ctx.beginPath(); ctx.rect(X(0.618), Y(0.238), X(0.015), Y(0.228)); ctx[op]();
      ctx.beginPath();
      ctx.moveTo(X(0.625), Y(0.262)); ctx.lineTo(X(0.694), Y(0.286));
      ctx.lineTo(X(0.625), Y(0.310));
      ctx.closePath(); ctx[op]();
    },

    /* the real car: alpha mask into the solver, no vector outline needed
       (the coloured sprite is composited in the display shader instead) */
    carReal: function (ctx, W, H, op) {
      if (op !== 'fill' || !CAR_MASK) return false;
      var w = CAR_RECT.w * W;
      var h = w / CAR_IMG_AR;
      ctx.drawImage(CAR_MASK, CAR_RECT.x * W, CAR_RECT.bottomY * H - h, w, h);
      return true;
    },

    /* the real ship: alpha mask into the solver */
    shipReal: function (ctx, W, H, op) {
      if (op !== 'fill' || !SHIP_MASK) return false;
      var r = shipRectFor(W / H);
      var w = r.w * W;
      var h = w / SHIP_IMG_AR;
      ctx.drawImage(SHIP_MASK, r.x * W, r.bottomY * H - h, w, h);
      return true;
    },

    /* the real jet: alpha mask into the solver */
    planeReal: function (ctx, W, H, op) {
      if (op !== 'fill' || !PLANE_MASK) return false;
      var r = planeRectFor(W / H);
      var w = r.w * W;
      var h = w / PLANE_IMG_AR;
      ctx.drawImage(PLANE_MASK, r.x * W, r.bottomY * H - h, w, h);
      return true;
    }
  };
  SIL.carReal.noStroke = true;
  SIL.shipReal.noStroke = true;
  SIL.planeReal.noStroke = true;

  /* --------------------------------- scenes ------------------------------- */
  var SCENES = {
    car: {
      mode: 0, sil: 'carReal', flowDir: 1,  /* wind left -> right, real 458 body */
      inflow: 6.6, gust: 0.42,
      velDiss: 0.20, denDiss: 3.10, curl: 17, pressure: 0.82,
      /* fine filaments: the lowest one slams into the roof leading edge and
         separates over the canopy — the classic tunnel shot */
      lineCount: 4, lineFrom: 0.415, lineTo: 0.74,
      lines2: { count: 2, from: 0.09, to: 0.155 },
      dye: [0.34, 0.70, 1.00], dyeVar: 0.30, dyeGain: 0.036, splatRadius: 0.050,
      tag: 'Live · ferrari-458.glb · wind tunnel',
      foot: [['wind', '6.6 m/s'], ['model', 'ferrari 458'], ['solver', 'navier-stokes']]
    },
    figure: {
      mode: 0, sil: 'figure', flowDir: 1,
      inflow: 4.6, gust: 0.80,
      velDiss: 0.28, denDiss: 2.30, curl: 34, pressure: 0.80,
      /* rake aimed just over the head and just under the base */
      lineCount: 4, lineFrom: 0.030, lineTo: 0.092,
      lines2: { count: 3, from: 0.845, to: 0.950 },
      dye: [0.42, 0.88, 0.84], dyeVar: 0.34, dyeGain: 0.062, splatRadius: 0.075,
      tag: 'Live · figure.glb · gust',
      foot: [['wind', '4.6 m/s'], ['gust', 'strong'], ['solver', 'navier-stokes']]
    },
    hull: {
      mode: 1, sil: 'shipReal', flowDir: -1, /* water flows right -> left, the real tall ship heads right */
      inflow: 5.2, gust: 0.30,
      velDiss: 0.14, denDiss: 1.55, curl: 19, pressure: 0.86,
      /* A ship makes a surface wake. Inlet dye lines look like smoke, even
         when they are blue, so only the hull sheds visible flow. */
      lineCount: 0, lineFrom: 0.100, lineTo: 0.440,
      dye: [0.28, 0.56, 0.92], dyeVar: 0.26, dyeGain: 0.030, splatRadius: 0.042,
      waterLine: 0.50, heave: 0.0125, pitchDeg: 1.6, waveAmp: 0.0090,
      tag: 'Live · sail-ship.glb · seaway',
      foot: [['water', '5.2 m/s'], ['wake', 'shedding'], ['solver', 'navier-stokes']]
    },
    plane: {
      mode: 0, sil: 'planeReal', flowDir: 1,  /* wind left -> right, the real jet noses into it */
      inflow: 7.2, gust: 0.34,
      velDiss: 0.19, denDiss: 2.90, curl: 20, pressure: 0.84,
      /* one rake sweeps the whole airframe: the flow slams into the nose,
         parts around the fuselage and trails off the wing. No clean band
         floating above the plane — every wisp touches the aircraft.        */
      lineCount: 4, lineFrom: 0.150, lineTo: 0.460,
      dye: [0.34, 0.70, 1.00], dyeVar: 0.30, dyeGain: 0.036, splatRadius: 0.050,
      tag: 'Live · regional-jet.glb · wind tunnel',
      foot: [['wind', '7.2 m/s'], ['model', 'regional jet'], ['solver', 'navier-stokes']]
    }
  };

  /* ---------------------------- mask rasterising -------------------------- */
  function newCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function rasterizeObstacle(cv, scene, t) {
    var ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';

    /* tunnel roof + floor */
    var wall = Math.max(2, Math.round(H * 0.02));
    ctx.fillRect(0, 0, W, wall);
    ctx.fillRect(0, H - wall, W, wall);

    /* the real ship sprite is composited by the display shader WITHOUT any
       bob, so the solid mask must be static too — otherwise the flow wraps
       around a hull that is not where the eye sees it.                        */
    var drawn = SIL[scene.sil](ctx, W, H, 'fill');
    if (drawn === false) {
      /* no silhouette yet for the real models: the ship falls back to its
         vector hull, the jet waits for its sprite rather than faking a car */
      var fb = scene.sil === 'shipReal' ? 'hull' : (scene.sil === 'planeReal' ? null : 'car');
      if (fb) SIL[fb](ctx, W, H, 'fill');
    }
    ctx.restore();
  }

  function rasterizeInflow(cv, dir) {
    var ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    /* the inlet sits upstream of the flow direction */
    if (dir > 0) ctx.fillRect(0, 0, Math.max(2, Math.round(W * 0.022)), H);
    else ctx.fillRect(W - Math.max(2, Math.round(W * 0.022)), 0, Math.max(2, Math.round(W * 0.022)), H);
  }

  function rasterizeOpen(cv, dir) {
    var ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    /* the outlet is downstream */
    if (dir > 0) ctx.fillRect(W - 2, 0, 2, H);
    else ctx.fillRect(0, 0, 2, H);
  }

  /* =========================== solver instance ============================ */
  function create(opts) {
    var canvas = opts.canvas;
    var overlay = opts.overlay || null;
    var pixelRatio = Math.min(global.devicePixelRatio || 1, 2);

    var info = getContext(canvas);
    if (!info) return null;
    var gl = info.gl;

    var SIM_RES = opts.simResolution || 168;
    var DYE_RES = opts.dyeResolution || 640;
    var PRESSURE_ITERATIONS = opts.pressureIterations || 24;

    /* ---- geometry ---- */
    var quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    var elem = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elem);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    /* ---- programs ---- */
    var pClear   = new Program(gl, VERT, F_CLEAR);
    var pSplat   = new Program(gl, VERT, F_SPLAT);
    var pAdvect  = new Program(gl, VERT, F_ADVECT);
    var pBound   = new Program(gl, VERT, F_BOUNDARY);
    var pCurl    = new Program(gl, VERT, F_CURL);
    var pVort    = new Program(gl, VERT, F_VORTICITY);
    var pDiv     = new Program(gl, VERT, F_DIVERGENCE);
    var pPress   = new Program(gl, VERT, F_PRESSURE);
    var pGrad    = new Program(gl, VERT, F_GRADIENT);
    var pDisplay = new Program(gl, VERT, F_DISPLAY);

    var velocity, dye, div, curlTex, pressure;
    var obsTex, inflowTex, openTex, obsCv, inflowCv, openCv;
    var scene = SCENES[opts.scene || 'car'];
    var running = false, rafId = 0, lastTime = 0;
    var octx = overlay ? overlay.getContext('2d') : null;
    var queued = [];
    var ptr = { down: false, x: 0, y: 0, px: 0, py: 0 };
    var warm = 0;

    /* real-model sprite state */
    var spriteTex = null, spriteReady = false;
    var blankTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, blankTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));

    if (opts.spriteSrc && global.Image) {
      var carImg = new Image();
      carImg.onload = function () {
        CAR_MASK = buildCarMask(carImg);
        spriteTex = makeMaskTexture();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, spriteTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, carImg);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        spriteReady = true;
        if (scene.sil === 'carReal') {
          rasterizeObstacle(obsCv, scene, 0);
          uploadMask(obsTex, obsCv);
        }
      };
      carImg.src = opts.spriteSrc;
    }

    /* real ship sprite state (separate texture so car + ship can coexist) */
    var shipTex = null, shipReady = false;
    if (opts.shipSrc && global.Image) {
      var shipImg = new Image();
      shipImg.onload = function () {
        SHIP_MASK = buildShipMask(shipImg);
        shipTex = makeMaskTexture();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, shipTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, shipImg);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        shipReady = true;
        if (scene.sil === 'shipReal') {
          rasterizeObstacle(obsCv, scene, 0);
          uploadMask(obsTex, obsCv);
        }
      };
      shipImg.src = opts.shipSrc;
    }

    /* real plane sprite state (a third texture so car + ship + jet coexist) */
    var planeTex = null, planeReady = false;
    if (opts.planeSrc && global.Image) {
      var planeImg = new Image();
      planeImg.onload = function () {
        PLANE_MASK = buildPlaneMask(planeImg);
        planeTex = makeMaskTexture();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, planeTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, planeImg);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        planeReady = true;
        if (scene.sil === 'planeReal') {
          rasterizeObstacle(obsCv, scene, 0);
          uploadMask(obsTex, obsCv);
        }
      };
      planeImg.src = opts.planeSrc;
    }

    function makeMaskTexture() {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, CLAMP);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, CLAMP);
      return tex;
    }

    function uploadMask(tex, cv) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }

    function initFramebuffers() {
      var ratio = canvas.height / canvas.width;
      var simW = SIM_RES;
      var simH = Math.max(64, Math.round(SIM_RES * ratio));
      var dyeW = DYE_RES;
      var dyeH = Math.max(128, Math.round(DYE_RES * ratio));
      var filtering = info.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

      velocity = makeDoubleFBO(gl, simW, simH, info.formatRGBA.internalFormat, info.formatRGBA.format, info.halfFloatTexType, filtering);
      dye      = makeDoubleFBO(gl, dyeW, dyeH, info.formatRGBA.internalFormat, info.formatRGBA.format, info.halfFloatTexType, filtering);
      div      = makeFBO(gl, simW, simH, info.formatR.internalFormat, info.formatR.format, info.halfFloatTexType, gl.NEAREST);
      curlTex  = makeFBO(gl, simW, simH, info.formatR.internalFormat, info.formatR.format, info.halfFloatTexType, gl.NEAREST);
      pressure = makeDoubleFBO(gl, simW, simH, info.formatR.internalFormat, info.formatR.format, info.halfFloatTexType, gl.NEAREST);

      obsCv = newCanvas(simW, simH);
      inflowCv = newCanvas(simW, simH);
      openCv = newCanvas(simW, simH);

      obsTex = makeMaskTexture();
      inflowTex = makeMaskTexture();
      openTex = makeMaskTexture();

      rasterizeInflow(inflowCv, scene.flowDir);
      uploadMask(inflowTex, inflowCv);
      rasterizeOpen(openCv, scene.flowDir);
      uploadMask(openTex, openCv);
      rasterizeObstacle(obsCv, scene, 0);
      uploadMask(obsTex, obsCv);

      warm = 0;
    }

    function resizeCanvas() {
      var rect = canvas.getBoundingClientRect();
      var w = Math.max(2, Math.round((rect.width || 420) * pixelRatio));
      var h = Math.max(2, Math.round((rect.height || 420) * pixelRatio));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        if (overlay) { overlay.width = w; overlay.height = h; }
        return true;
      }
      return false;
    }

    /* ------------------------------ splat --------------------------------- */
    function correctRadius(r) {
      var ar = canvas.width / canvas.height;
      return ar > 1 ? r * ar : r;
    }

    function splat(x, y, dx, dy, color, radiusOverride) {
      pSplat.bind();
      gl.uniform1f(pSplat.u.aspectRatio, canvas.width / canvas.height);
      gl.uniform2f(pSplat.u.point, x, y);
      gl.uniform1f(pSplat.u.radius, correctRadius((radiusOverride || scene.splatRadius) / 100.0));

      gl.uniform1i(pSplat.u.uTarget, velocity.read.attach(0));
      gl.uniform3f(pSplat.u.color, dx, dy, 0.0);
      blit(gl, velocity.write);
      velocity.swap();

      gl.uniform1i(pSplat.u.uTarget, dye.read.attach(0));
      gl.uniform3f(pSplat.u.color, color[0], color[1], color[2]);
      blit(gl, dye.write);
      dye.swap();
    }

    function dyeColor(base, variance) {
      var g = scene.dyeGain;
      var m = function (c) { return c * (0.74 + Math.random() * (variance || 0.3)) * g; };
      return [m(base[0]), m(base[1]), m(base[2])];
    }

    /* --------------------------- injection -------------------------------- */
    function gustFactor(t) {
      /* symmetric around 1 so a strong gust setting can never reverse the flow */
      var g = 1
        + Math.sin(t * 0.00052) * scene.gust * 0.50
        + Math.sin(t * 0.00171 + 2.1) * scene.gust * 0.30
        + Math.sin(t * 0.00383) * scene.gust * 0.16;
      return Math.max(0.18, g);
    }

    /* smoke filaments fed in at the inlet, one puff per line per frame */
    function injectLines(t) {
      var g = gustFactor(t);
      var u = scene.flowDir * scene.inflow * 23 * g;
      var x = scene.flowDir > 0 ? 0.011 : 0.989;
      var inject = function (count, from, to) {
        for (var i = 0; i < count; i++) {
          var f = count === 1 ? 0.5 : i / (count - 1);
          var y = from + (to - from) * f;
          y += Math.sin(t * 0.0009 + i * 0.7) * 0.0035;
          splat(x, y, u, 0, dyeColor(scene.dye, scene.dyeVar));
        }
      };
      inject(scene.lineCount, scene.lineFrom, scene.lineTo);
      if (scene.lines2) inject(scene.lines2.count, scene.lines2.from, scene.lines2.to);
    }

    /* foam at the stem + a wake continuously shed off the transom.
       Every splat in this file uses y-up uv (0 = bottom); the waterline is at
       y = 1 - scene.waterLine. The stem/stern x are derived from the real
       ship sprite so the foam tracks the actual hull on any canvas ratio.     */
    function hullPoints() {
      /* waterline crossing measured on the rendered ship PNG (image-space x) */
      var BOW = 0.725, STERN = 0.050;
      if (scene.sil === 'shipReal' && shipReady) {
        var r = shipRectFor(canvas.width / canvas.height);
        return { bow: r.x + BOW * r.w, stern: r.x + STERN * r.w };
      }
      return { bow: 0.70, stern: 0.12 };
    }

    function injectHull(t) {
      var wl = 1 - scene.waterLine;              /* y-up, matches the shader */
      var p = hullPoints();
      var g = scene.dyeGain;
      var foam = [0.90, 0.97, 1.00];             /* whitewater */
      var deep = [0.30, 0.62, 0.95];             /* sea-blue current */
      var pulse = 0.75 + Math.abs(Math.sin(t * 0.0021)) * 0.6;

      /* bow: broken whitewater AT the waterline — never a tall pale column,
         that reads as smoke. The stem shoulders water aside; foam sheds aft. */
      splat(p.bow, wl - 0.004, -95 * pulse, 6 * pulse,
        [foam[0] * g * 2.0, foam[1] * g * 2.0, foam[2] * g * 2.0], 0.028);
      splat(p.bow - 0.016, wl - 0.010, -70 * pulse, -6 * pulse,
        [foam[0] * g * 1.4, foam[1] * g * 1.4, foam[2] * g * 1.4], 0.022);
      /* spray: two droplets off the stem, low and tight — anything higher
         or wider turns into pale smoke columns above the line            */
      for (var i = 0; i < 2; i++) {
        splat(p.bow - 0.006 + (Math.random() - 0.5) * 0.010,
              wl + 0.002 + Math.random() * 0.006,
              -60 * pulse - Math.random() * 50,
              10 + Math.random() * 22,
              [foam[0] * g * 2.2, foam[1] * g * 2.2, foam[2] * g * 2.2],
              0.006 + Math.random() * 0.005);
      }
      /* under-bow current: the sea is deflected DOWN along the hull */
      splat(p.bow - 0.030, wl - 0.034, -80 * pulse, -34 * pulse,
        [deep[0] * g * 1.8, deep[1] * g * 1.8, deep[2] * g * 1.8], 0.044);

      /* stern: whitewater off the transom, then the wake carried downstream */
      var shed = 0.60 + Math.abs(Math.sin(t * 0.0013)) * 0.55;
      splat(p.stern, wl - 0.005, -100 * shed, -4 * shed,
        [foam[0] * g * 2.2, foam[1] * g * 2.2, foam[2] * g * 2.2], 0.030);
      splat(p.stern + 0.025, wl - 0.030, -70 * shed, -30 * shed,
        [deep[0] * g * 2.0, deep[1] * g * 2.0, deep[2] * g * 2.0], 0.042);

      /* broken water where the hull meets the sea */
      for (var i = 0; i < 3; i++) {
        var f = 0.22 + i * 0.28;
        var x = p.stern + (p.bow - p.stern) * f;
        splat(x, wl - 0.004, -55 * shed, -6 * shed,
          [foam[0] * g * 0.9, foam[1] * g * 0.9, foam[2] * g * 0.9], 0.020);
      }
    }

    /* wake: shed continuously from the transom */
    /* hair: a thin stream fed at the crown, carried by the wind itself.
       The strands you see are dye advected by the real velocity field —
       that is why the flicker and separation look alive.                    */
    function injectHair(t) {
      if (scene.sil !== 'figure') return;
      var g = scene.dyeGain;
      var sway = Math.sin(t * 0.0021) * 0.012;
      var flutter = Math.sin(t * 0.0037 + 1.3) * 42;
      var u = scene.flowDir * scene.inflow * 23 * gustFactor(t) * 0.42;
      splat(0.488, 0.845 + sway, u, flutter, [0.85 * g, 0.62 * g, 1.05 * g], 0.050);
      splat(0.505, 0.828 + sway * 0.6, u * 0.8, flutter * 0.7, [0.45 * g, 0.85 * g, 1.00 * g], 0.044);
    }

    /* wake: turbulent dye shed continuously off the car's tail */
    function injectCarWake(t) {
      if (scene.sil !== 'carReal') return;
      var g = scene.dyeGain * 1.25;
      var shed = 0.65 + Math.abs(Math.sin(t * 0.0016)) * 0.6;
      var flap = Math.sin(t * 0.0027) * 0.014;
      var u = scene.flowDir * scene.inflow * 16 * shed;
      splat(0.852, 0.302 + flap, u, 14 * shed, [0.40 * g, 0.66 * g, 0.94 * g], 0.048);
      splat(0.838, 0.372 + flap * 0.6, u * 0.75, -22 * shed, [0.30 * g, 0.55 * g, 0.85 * g], 0.040);
    }

    /* jet: the counter-rotating pair rolls up off the wing and trails
       downstream, plus the tail-cone wake — the tunnel shot every aircraft
       modeller knows. Both anchors are read off the real sprite rect, so the
       trails start exactly where the eye sees the wing and the tail.         */
    function injectPlane(t) {
      if (scene.sil !== 'planeReal' || !planeReady) return;
      var g = scene.dyeGain;
      var r = planeRectFor(canvas.width / canvas.height);
      var hUv = r.w * (canvas.width / canvas.height) / PLANE_IMG_AR;
      /* png fraction -> canvas uv (y-up): wing root at x .475 / y .831,
         tail cone at x .895 / y .727, measured on the rendered jet png */
      var toUv = function (fx, fy) {
        return { x: r.x + fx * r.w, y: 1 - (r.bottomY - hUv + fy * hUv) };
      };
      var wing = toUv(0.475, 0.831);
      var tail = toUv(0.895, 0.727);
      var shed = 0.60 + Math.abs(Math.sin(t * 0.0015)) * 0.55;
      var u = scene.flowDir * scene.inflow * 15 * shed;
      var wob = Math.sin(t * 0.0026) * 0.004;
      /* the pair: one core above the chord, one below, counter-rotating */
      splat(wing.x + 0.010, wing.y + 0.024 + wob, u * 0.92,  34 * shed,
        [0.40 * g, 0.66 * g, 0.94 * g], 0.014);
      splat(wing.x + 0.010, wing.y - 0.024 + wob, u * 0.92, -34 * shed,
        [0.30 * g, 0.55 * g, 0.85 * g], 0.014);
      /* tail cone wake */
      splat(tail.x, tail.y + wob * 0.6, u * 0.80, Math.sin(t * 0.0031) * 12,
        [0.34 * g, 0.62 * g, 0.92 * g], 0.020);
    }

    /* ------------------------------ boundary ------------------------------ */
    function applyBoundary(obsVel) {
      pBound.bind();
      gl.uniform1i(pBound.u.uVelocity, velocity.read.attach(0));
      gl.uniform1i(pBound.u.uObstacle, 1);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, obsTex);
      gl.uniform1i(pBound.u.uInflow, 2);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, inflowTex);
      gl.uniform2f(pBound.u.uObstacleVel, obsVel[0], obsVel[1]);
      gl.uniform2f(pBound.u.uInflowVel, scene.flowDir * scene.inflow * 23 * gustFactor(lastTime), 0.0);
      blit(gl, velocity.write);
      velocity.swap();
    }

    /* -------------------------------- step -------------------------------- */
    function step(dt) {
      gl.disable(gl.BLEND);

      /* solid bodies + inlet */
      applyBoundary([0, 0]);

      /* curl + vorticity confinement */
      pCurl.bind();
      gl.uniform2f(pCurl.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(pCurl.u.uVelocity, velocity.read.attach(0));
      blit(gl, curlTex);

      pVort.bind();
      gl.uniform2f(pVort.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(pVort.u.uVelocity, velocity.read.attach(0));
      gl.uniform1i(pVort.u.uCurl, curlTex.attach(1));
      gl.uniform1f(pVort.u.curl, scene.curl);
      gl.uniform1f(pVort.u.dt, dt);
      blit(gl, velocity.write);
      velocity.swap();

      applyBoundary([0, 0]);

      /* divergence */
      pDiv.bind();
      gl.uniform2f(pDiv.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(pDiv.u.uVelocity, velocity.read.attach(0));
      gl.uniform1i(pDiv.u.uObstacle, 1);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, obsTex);
      blit(gl, div);

      /* pressure */
      pClear.bind();
      gl.uniform1i(pClear.u.uTexture, pressure.read.attach(0));
      gl.uniform1f(pClear.u.value, scene.pressure);
      blit(gl, pressure.write);
      pressure.swap();

      pPress.bind();
      gl.uniform2f(pPress.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(pPress.u.uDivergence, div.attach(0));
      gl.uniform1i(pPress.u.uObstacle, 1);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, obsTex);
      gl.uniform1i(pPress.u.uOpen, 2);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, openTex);
      var i;
      for (i = 0; i < PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pPress.u.uPressure, pressure.read.attach(3));
        blit(gl, pressure.write);
        pressure.swap();
      }

      /* project */
      pGrad.bind();
      gl.uniform2f(pGrad.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(pGrad.u.uPressure, pressure.read.attach(0));
      gl.uniform1i(pGrad.u.uVelocity, velocity.read.attach(1));
      gl.uniform1i(pGrad.u.uObstacle, 2);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, obsTex);
      blit(gl, velocity.write);
      velocity.swap();

      applyBoundary([0, 0]);

      /* advect velocity */
      pAdvect.bind();
      gl.uniform2f(pAdvect.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1f(pAdvect.u.dt, dt);
      gl.uniform1f(pAdvect.u.uFlowDir, scene.flowDir);
      var velId = velocity.read.attach(0);
      gl.uniform1i(pAdvect.u.uVelocity, velId);
      gl.uniform1i(pAdvect.u.uSource, velId);
      gl.uniform1f(pAdvect.u.dissipation, scene.velDiss);
      blit(gl, velocity.write);
      velocity.swap();

      /* advect dye */
      gl.uniform1i(pAdvect.u.uVelocity, velocity.read.attach(0));
      gl.uniform1i(pAdvect.u.uSource, dye.read.attach(1));
      gl.uniform1f(pAdvect.u.dissipation, scene.denDiss);
      blit(gl, dye.write);
      dye.swap();
    }

    /* ------------------------------- render ------------------------------- */
    function render(now) {
      pDisplay.bind();
      gl.uniform2f(pDisplay.u.texelSize, 1 / gl.drawingBufferWidth, 1 / gl.drawingBufferHeight);
      gl.uniform1i(pDisplay.u.uTexture, dye.read.attach(0));
      gl.uniform1i(pDisplay.u.uObstacle, 1);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, obsTex);
      gl.uniform1f(pDisplay.u.uMode, scene.mode);
      gl.uniform1f(pDisplay.u.uTime, (now || 0) * 0.001);
      /* the real car or the real ship, composited over the flow */
      var rect = null, tex = null;
      if (scene.sil === 'carReal' && spriteReady) { rect = CAR_RECT; tex = spriteTex; }
      if (scene.sil === 'shipReal' && shipReady) { rect = shipRectFor(canvas.width / canvas.height); tex = shipTex; }
      if (scene.sil === 'planeReal' && planeReady) { rect = planeRectFor(canvas.width / canvas.height); tex = planeTex; }
      if (tex) {
        var aspect = canvas.width / canvas.height;
        var imgAR = CAR_IMG_AR;
        if (scene.sil === 'shipReal') imgAR = SHIP_IMG_AR;
        if (scene.sil === 'planeReal') imgAR = PLANE_IMG_AR;
        var hUv = rect.w * aspect / imgAR;
        gl.uniform1i(pDisplay.u.uSprite, 2);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform4f(pDisplay.u.uSpriteRect, rect.x, 1 - rect.bottomY, rect.w, hUv);
      } else {
        gl.uniform1i(pDisplay.u.uSprite, 2);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, blankTex);
        gl.uniform4f(pDisplay.u.uSpriteRect, 0, 0, 0, 0);
      }
      if (scene.mode === 1) {
        gl.uniform3f(pDisplay.u.uBgTop, 0.012, 0.129, 0.235);
        gl.uniform3f(pDisplay.u.uBgBot, 0.004, 0.047, 0.098);
        gl.uniform1f(pDisplay.u.uWaterLine, 1 - scene.waterLine);   /* shader uv is y-up */
      } else {
        gl.uniform3f(pDisplay.u.uBgTop, 0.020, 0.031, 0.055);
        gl.uniform3f(pDisplay.u.uBgBot, 0.008, 0.012, 0.024);
        gl.uniform1f(pDisplay.u.uWaterLine, 2.0);
      }
      blit(gl, null);
    }

    /* ------------------------------- overlay ------------------------------ */
    function drawOverlay(t) {
      if (!octx) return;
      var ctx = octx, W = overlay.width, H = overlay.height;
      ctx.clearRect(0, 0, W, H);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      /* outline of the model, sitting on top of the flow
         (the real car / ship sprite carries its own colour, no outline) */
      if (SIL[scene.sil] && !SIL[scene.sil].noStroke) {
        ctx.save();
        ctx.strokeStyle = 'rgba(233,240,248,.94)';
        ctx.lineWidth = Math.max(1.1, W * 0.0030);
        ctx.shadowColor = 'rgba(94,234,212,.6)';
        ctx.shadowBlur = W * 0.016;
        SIL[scene.sil](ctx, W, H, 'stroke');
        ctx.restore();
      }

      if (scene.mode === 1) {
        /* seaway: one bright crest at the waterline, two deeper swell bands,
           and broken whitecaps that bunch up around the hull               */
        var wl = scene.waterLine;
        var amp = scene.waveAmp * H;
        var heave = Math.sin(t * 0.0011) * scene.heave * H;
        var waveAt = function (x, k, ph, a) {
          return H * wl + heave +
                 Math.sin(x / W * k + t * 0.0016 + ph) * a +
                 Math.sin(x / W * k * 2.1 - t * 0.0023 + ph) * a * 0.45;
        };
        var bands = [
          { k: 7.2,  ph: 0.0, a: amp,       w: 0.0022, c: 'rgba(176,255,246,.80)', blur: 0.018, dy: 0 },
          { k: 11.0, ph: 2.1, a: amp * 0.8, w: 0.0016, c: 'rgba(150,230,255,.42)', blur: 0.010, dy: 0.020 },
          { k: 16.5, ph: 4.4, a: amp * 0.6, w: 0.0013, c: 'rgba(140,215,250,.26)', blur: 0.008, dy: 0.042 }
        ];
        bands.forEach(function (b) {
          var yOff = H * b.dy;
          ctx.beginPath();
          ctx.moveTo(0, waveAt(0, b.k, b.ph, b.a) + yOff);
          for (var x = 4; x <= W; x += 4) ctx.lineTo(x, waveAt(x, b.k, b.ph, b.a) + yOff);
          ctx.strokeStyle = b.c;
          ctx.lineWidth = Math.max(1, W * b.w);
          ctx.shadowColor = 'rgba(94,234,212,.9)';
          ctx.shadowBlur = W * b.blur;
          ctx.stroke();
        });

        /* whitecaps */
        var hull = hullPoints();
        var mid = (hull.bow + hull.stern) * 0.5;
        var hash = function (n) { var s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
        ctx.shadowBlur = 0;
        for (var i = 0; i < 34; i++) {
          var hx = hash(i), hy = hash(i + 40), ht = hash(i + 80);
          var nearHull = Math.exp(-Math.pow((hx - mid) * 3.1, 2));
          var flick = 0.35 + 0.65 * Math.abs(Math.sin(t * 0.0021 + ht * 6.283));
          var a = (0.05 + nearHull * 0.50) * flick;
          if (a < 0.035) continue;
          var cx = hx * W;
          var len = W * (0.006 + hy * 0.013 + nearHull * 0.010);
          var yy = waveAt(cx, 7.2, 0, amp) + (hy - 0.5) * H * 0.006;
          ctx.strokeStyle = 'rgba(235,250,255,' + a.toFixed(3) + ')';
          ctx.lineWidth = Math.max(1, W * (0.0013 + nearHull * 0.0015));
          ctx.beginPath();
          ctx.moveTo(cx - len / 2, yy);
          ctx.quadraticCurveTo(cx, yy - H * 0.004, cx + len / 2, yy);
          ctx.stroke();
        }

        /* bow wave: a bright crest piles up at the stem and runs forward */
        var bw = hullPoints();
        var bwX = bw.bow * W;
        var bwY = waveAt(bwX, 7.2, 0, amp);
        ctx.save();
        ctx.strokeStyle = 'rgba(205,252,255,.55)';
        ctx.lineWidth = Math.max(1.2, W * 0.0026);
        ctx.shadowColor = 'rgba(94,234,212,.9)';
        ctx.shadowBlur = W * 0.014;
        ctx.beginPath();
        ctx.moveTo(bwX - W * 0.004, bwY - H * 0.004);
        ctx.quadraticCurveTo(bwX + W * 0.040, bwY - H * 0.022,
                             bwX + W * 0.082, bwY + H * 0.005);
        ctx.stroke();
        ctx.restore();

        /* The ship points right, so its surface wake trails left of the
           stern. Short broken crests read as water rather than smoke. */
        var sternX = bw.stern * W;
        for (var j = 0; j < 3; j++) {
          var drift = (t * 0.00013 + j / 3) % 1;
          var wakeX = sternX - drift * W * 0.15;
          if (wakeX < 4) continue;
          var wakeY = waveAt(wakeX, 7.2, 0, amp) + H * (0.006 + drift * 0.008);
          var wakeLen = W * (0.024 + drift * 0.032);
          ctx.beginPath();
          ctx.moveTo(wakeX - wakeLen, wakeY + H * 0.003);
          ctx.quadraticCurveTo(wakeX - wakeLen * 0.5, wakeY - H * 0.007,
                               wakeX, wakeY);
          ctx.strokeStyle = 'rgba(210,250,255,' + (0.50 * (1 - drift) + 0.14).toFixed(3) + ')';
          ctx.lineWidth = Math.max(1.2, W * (0.0028 - drift * 0.0013));
          ctx.shadowColor = 'rgba(115,230,250,.65)';
          ctx.shadowBlur = W * 0.008;
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
      }
      /* air scenes carry no HUD chrome: the flow and the model are the picture */
    }

    /* -------------------------------- loop -------------------------------- */
    function frame(now) {
      if (!running) return;
      rafId = requestAnimationFrame(frame);
      if (resizeCanvas()) initFramebuffers();

      var dt = (now - lastTime) / 1000;
      if (!(dt > 0) || dt > 0.05) dt = 0.0166;
      lastTime = now;

      /* the model moves with the wave, so the solid mask is rebuilt each frame
         in water mode; in air mode it is static after init */
      if (scene.mode === 1) {
        rasterizeObstacle(obsCv, scene, now);
        uploadMask(obsTex, obsCv);
      }

      while (queued.length) {
        var s = queued.shift();
        splat(s.x, s.y, s.dx, s.dy, s.color);
      }

      /* pre-roll so the tunnel is already flowing when you look at it */
      var reps = warm < 45 ? 3 : 1;
      for (var k = 0; k < reps; k++) {
        injectLines(now);
        if (scene.mode === 1) injectHull(now);
        injectHair(now);
        injectCarWake(now);
        injectPlane(now);
        step(dt);
      }
      warm++;

      render(now);
      drawOverlay(now);
    }

    /* ----------------------------- interaction ---------------------------- */
    function pos(e) {
      var r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: 1 - (e.clientY - r.top) / r.height };
    }
    function onDown(e) {
      var p = pos(e);
      ptr.down = true; ptr.x = ptr.px = p.x; ptr.y = ptr.py = p.y;
      queue(p.x, p.y, 0, 0, true);
    }
    function onMove(e) {
      if (!ptr.down) return;
      var p = pos(e);
      ptr.px = ptr.x; ptr.py = ptr.y; ptr.x = p.x; ptr.y = p.y;
      queue(p.x, p.y, ptr.x - ptr.px, ptr.y - ptr.py, false);
    }
    function onUp() { ptr.down = false; }
    function queue(x, y, dx, dy, isClick) {
      var col = scene.mode === 1 ? [0.50, 0.74, 0.92] : [isClick ? 0.55 : 0.32, 0.72, 1.05];
      queued.push({ x: x, y: y, dx: dx * 5800, dy: dy * 5800,
                    color: [col[0] * scene.dyeGain * 4, col[1] * scene.dyeGain * 4, col[2] * scene.dyeGain * 4] });
      if (queued.length > 10) queued.splice(0, queued.length - 10);
    }

    /* ------------------------------- public ------------------------------- */
    function setScene(name) {
      if (!SCENES[name]) return;
      scene = SCENES[name];
      queued.length = 0;
      initFramebuffers();
    }
    function start() {
      if (running) return;
      running = true;
      lastTime = performance.now();
      rafId = requestAnimationFrame(frame);
    }
    function stop() { running = false; if (rafId) cancelAnimationFrame(rafId); rafId = 0; }

    /* ---- boot ---- */
    resizeCanvas();
    initFramebuffers();

    if (opts.interactive !== false) {
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      global.addEventListener('pointerup', onUp);
      global.addEventListener('pointercancel', onUp);
    }

    var reduced = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { render(); drawOverlay(0); } else { start(); }

    return {
      setScene: setScene, start: start, stop: stop,
      isRunning: function () { return running; },
      getScene: function () { return scene; },
      spriteReady: function () { return spriteReady; },
      shipReady: function () { return shipReady; },
      planeReady: function () { return planeReady; },
      isWebGL2: info.isWebGL2
    };
  }

  global.WakefieldFluid = { create: create, scenes: SCENES, silhouettes: SIL };
})(window);
