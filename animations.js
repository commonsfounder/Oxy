(function () {
  let initialized = false;

  function initOxyLandingAnimations() {
    const landing = document.querySelector('.landing');
    const scroller = document.querySelector('.auth-overlay');
    if (!landing || !scroller || initialized) return;
    if (!window.gsap || !window.ScrollTrigger) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    initialized = true;
    const { gsap, ScrollTrigger } = window;
    gsap.registerPlugin(ScrollTrigger);

    ScrollTrigger.defaults({
      scroller,
      ease: 'power3.out'
    });

    gsap.from('[data-hero-text]', {
      opacity: 0,
      scale: 0.965,
      y: 34,
      duration: 1.55,
      stagger: 0.16,
      ease: 'power3.out',
      delay: 0.18
    });

    gsap.to('[data-product-pendant]', {
      scale: 1.08,
      duration: 2.4,
      ease: 'sine.inOut',
      repeat: -1,
      yoyo: true
    });

    gsap.utils.toArray('[data-parallax-bg]').forEach(bg => {
      gsap.to(bg, {
        yPercent: 12,
        ease: 'none',
        scrollTrigger: {
          trigger: bg.parentElement,
          start: 'top bottom',
          end: 'bottom top',
          scrub: 1.6
        }
      });
    });

    gsap.utils.toArray('[data-product-pendant]').forEach(product => {
      gsap.fromTo(product,
        { scale: 0.92, opacity: 0.72 },
        {
          scale: 1.04,
          opacity: 0.94,
          ease: 'power2.out',
          scrollTrigger: {
            trigger: product,
            start: 'top 82%',
            end: 'center 32%',
            scrub: 1.4
          }
        }
      );
    });

    gsap.utils.toArray('[data-pin-section]').forEach(section => {
      const copy = section.querySelectorAll('[data-section-copy]');
      const phrases = section.querySelectorAll('.feature-phrase');

      const timeline = gsap.timeline({
        scrollTrigger: {
          trigger: section,
          start: 'top top',
          end: '+=130%',
          pin: true,
          scrub: 1.7,
          anticipatePin: 1
        }
      });

      timeline.from(copy, {
        opacity: 0,
        y: 72,
        duration: 1.1,
        stagger: 0.12,
        ease: 'power3.out'
      });

      if (phrases.length) {
        timeline.to(phrases, {
          opacity: 1,
          y: 0,
          duration: 1.8,
          stagger: 0.16,
          ease: 'power3.out'
        }, '-=0.55');
      }
    });

    ScrollTrigger.refresh();
  }

  window.addEventListener('load', initOxyLandingAnimations);
  const observer = new MutationObserver(initOxyLandingAnimations);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
