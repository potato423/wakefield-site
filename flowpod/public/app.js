(function(){
  /* ============================================================
     Real fluid — GPU Navier-Stokes solver
     ============================================================ */
  var MOBILE = window.matchMedia && window.matchMedia('(max-width:760px)').matches;
  var SIM_RES   = MOBILE ? 128 : 176;
  var DYE_RES   = MOBILE ? 384 : 704;
  var PRESSURE  = MOBILE ? 18  : 26;

  var hero = null;
  if (window.WakefieldFluid) {
    var fc = document.getElementById('fluid');
    if (fc) {
      hero = window.WakefieldFluid.create({
        canvas: fc,
        overlay: document.getElementById('overlay'),
        scene: 'car',
        spriteSrc: 'assets/ferrari-body.png',
        shipSrc: 'assets/sailship-body.png',
        planeSrc: 'assets/jet-body.png',
        simResolution: SIM_RES,
        dyeResolution: DYE_RES,
        pressureIterations: PRESSURE,
        interactive: true
      });
    }
  }

  /* stop burning GPU when the visual scrolls out of view */
  window.__flowpod = { hero: hero };
  (function () {
    if (!('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!hero) return;
        if (en.isIntersecting) { if (!hero.isRunning()) hero.start(); }
        else { if (hero.isRunning()) hero.stop(); }
      });
    }, { threshold: 0.02 });
    Array.prototype.forEach.call(
      document.querySelectorAll('.hero-visual'),
      function (v) { io.observe(v); }
    );
  })();

  /* ============================================================
     Car / Ship / Plane tabs
     ============================================================ */
  (function () {
    var tabs = document.querySelectorAll('.tab');
    if (!tabs.length) return;
    Array.prototype.forEach.call(tabs, function (btn) {
      btn.addEventListener('click', function () {
        var k = btn.getAttribute('data-scene');
        Array.prototype.forEach.call(tabs, function (b) {
          b.classList.remove('on');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('on');
        btn.setAttribute('aria-selected', 'true');
        if (hero) hero.setScene(k);
      });
    });
  })();

  /* Send beta requests to the owner's inbox; keep a mail draft as a fallback. */
  var form = document.getElementById('form-final');
  var msg = document.getElementById('msg-final');
  var draft = document.getElementById('beta-draft');
  var requestText = document.getElementById('request-text');
  var openEmail = document.getElementById('open-email');
  var copyRequest = document.getElementById('copy-request');
  var submitButton = form.querySelector('button[type="submit"]');
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var email = form.elements.email.value.trim();
    var model = form.elements.model.value.trim();
    var flow = form.elements.flow.value;
    var wish = form.elements.wish.value.trim();
    msg.className = 'form-msg';
    draft.hidden = true;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      msg.textContent = 'Please check your email address.';
      msg.classList.add('err');
      form.elements.email.focus();
      return;
    }
    if (!model) {
      msg.textContent = 'Tell us which model you would bring.';
      msg.classList.add('err');
      form.elements.model.focus();
      return;
    }
    if (!wish) {
      msg.textContent = 'Tell us what else you would like Flowpod to make possible.';
      msg.classList.add('err');
      form.elements.wish.focus();
      return;
    }
    var subject = 'Flowpod beta request — ' + model;
    var body = 'Hello Flowpod,\n\nI would like to join the beta.\n\nMy email: ' + email +
      '\nMy model: ' + model + '\nFlow I want to see: ' + flow +
      '\n\nWhat else I would like Flowpod to make possible:\n' + wish;
    var href = 'mailto:jej03701@gmail.com?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(body);
    openEmail.href = href;
    requestText.value = 'To: jej03701@gmail.com\nSubject: ' + subject + '\n\n' + body;
    submitButton.disabled = true;
    submitButton.textContent = 'Sending…';
    msg.textContent = 'Sending your beta request…';
    msg.classList.add('ok');
    try {
      var response = await fetch('https://formsubmit.co/ajax/jej03701@gmail.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          email: email,
          model: model,
          flow: flow,
          wish: wish,
          _subject: subject,
          _replyto: email,
          _captcha: 'false',
          _honey: ''
        })
      });
      var result = await response.json();
      if (!response.ok || result.success === false || result.success === 'false') {
        throw new Error('Submission was not accepted');
      }
      form.reset();
      msg.textContent = 'Thanks — your beta request has been sent. We will contact you if a place opens.';
    } catch (error) {
      msg.className = 'form-msg err';
      msg.textContent = 'Online signup is unavailable right now. Use the email draft below to send your request.';
      draft.hidden = false;
      draft.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Join the beta';
    }
  });
  copyRequest.addEventListener('click', function () {
    function copied() {
      copyRequest.textContent = 'Copied';
      msg.textContent = 'Request copied. Paste it into an email and send it to complete signup.';
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(requestText.value).then(copied, function () {
        requestText.focus(); requestText.select();
        msg.textContent = 'Select and copy the request below, then email it to complete signup.';
      });
    } else {
      requestText.focus(); requestText.select();
      msg.textContent = 'Select and copy the request below, then email it to complete signup.';
    }
  });
})();
