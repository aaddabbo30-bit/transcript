// Motion, the way Apple builds it: springs instead of fixed-length
// animations, so anything moving can be re-targeted mid-flight from where it
// is on screen and at the speed it has; gestures that follow the pointer 1:1
// and hand their velocity to the spring when released.
// Springs take Apple's two parameters: response (seconds, how quickly it gets
// there) and damping ratio (1 = no overshoot, the default for UI).

export function reducedMotion(view = window) {
  try {
    return view.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * A spring on one number. set() re-targets it from its current value and
 * velocity, so an interruption never jumps. `viewOf` gives the window whose
 * frames drive it (the live panel can move to the always-on-top window).
 */
export class Spring {
  constructor(value, onUpdate, { response = 0.35, damping = 1, epsilon = 0.1, viewOf = () => window } = {}) {
    this.value = value;
    this.velocity = 0;
    this.target = value;
    this.onUpdate = onUpdate;
    this.response = response;
    this.damping = damping;
    this.epsilon = epsilon;
    this.viewOf = viewOf;
    this.frame = null;
    this.onRest = null;
  }

  /** Move to `target`. velocity: units per second to start with (a gesture's release speed). */
  set(target, { velocity, response, damping, onRest } = {}) {
    this.target = target;
    if (velocity !== undefined) this.velocity = velocity;
    if (response !== undefined) this.response = response;
    if (damping !== undefined) this.damping = damping;
    this.onRest = onRest || null;
    if (this.frame === null) this.run();
  }

  /** Put it there at once, at rest (the start of an entrance, or a drag following the pointer). */
  jump(value) {
    this.stop();
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.onUpdate(value);
  }

  stop() {
    if (this.frame !== null) {
      try {
        this.view.cancelAnimationFrame(this.frame);
      } catch {
        /* the window it ran in is gone */
      }
    }
    this.frame = null;
  }

  run() {
    this.view = this.viewOf() || window;
    let last = null;
    const step = (now) => {
      const dt = last === null ? 1 / 60 : Math.min(0.064, (now - last) / 1000);
      last = now;
      // Stiffness and damping from response and damping ratio (unit mass); small steps keep it stable.
      const k = (2 * Math.PI / this.response) ** 2;
      const c = (4 * Math.PI * this.damping) / this.response;
      const n = Math.max(1, Math.ceil(dt / (1 / 240)));
      for (let i = 0; i < n; i++) {
        const a = -k * (this.value - this.target) - c * this.velocity;
        this.velocity += a * (dt / n);
        this.value += this.velocity * (dt / n);
      }
      const resting = Math.abs(this.value - this.target) < this.epsilon && Math.abs(this.velocity) < this.epsilon * 10;
      if (resting) this.value = this.target;
      this.onUpdate(this.value);
      if (resting) {
        this.frame = null;
        this.velocity = 0;
        const done = this.onRest;
        this.onRest = null;
        if (done) done();
        return;
      }
      this.frame = this.view.requestAnimationFrame(step);
    };
    this.frame = this.view.requestAnimationFrame(step);
  }
}

/** Where a flick would come to rest (Apple's projection, as scroll deceleration does). */
export function project(velocity, decelerationRate = 0.998) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Past a boundary, things follow less and less: they resist, they don't stop dead. */
export function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/**
 * A banner that comes down from the top, goes back up when it's done, and can
 * be flicked away: it follows the pointer while held (resisting downwards), and
 * on release the velocity decides: thrown up, it leaves at that speed;
 * otherwise it settles back. A tap closes it too.
 */
export class Banner {
  constructor(el, { onClose = () => {} } = {}) {
    this.el = el;
    this.onClose = onClose;
    this.open = false;
    const viewOf = () => this.el.ownerDocument.defaultView;
    this.y = new Spring(0, (v) => this.paint(v), { response: 0.4, damping: 1, epsilon: 0.5, viewOf });
    el.addEventListener("pointerdown", (e) => this.grab(e));
  }

  get view() {
    return this.el.ownerDocument.defaultView || window;
  }

  get away() {
    return -(this.el.offsetHeight + 40);
  }

  paint(y) {
    this.el.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
    this.el.style.opacity = String(Math.max(0, Math.min(1, 1 + y / Math.max(1, -this.away))));
  }

  show() {
    const wasOpen = this.open;
    this.open = true;
    this.el.classList.remove("hidden");
    if (reducedMotion(this.view)) {
      this.y.jump(0);
      this.el.classList.add("fade-in");
      return;
    }
    // From where it is if it was leaving (interrupted), else from above the screen.
    if (!wasOpen && this.y.frame === null) this.y.jump(this.away);
    this.y.set(0, { response: 0.4, damping: 1 });
  }

  hide({ velocity } = {}) {
    if (!this.open) return;
    this.open = false;
    const done = () => {
      if (!this.open) this.el.classList.add("hidden");
    };
    this.el.classList.remove("fade-in");
    if (reducedMotion(this.view)) {
      this.y.jump(0);
      done();
      return;
    }
    this.y.set(this.away, { velocity, response: 0.35, damping: 1, onRest: done });
  }

  grab(e) {
    if (!this.open || e.button > 0) return;
    const el = this.el;
    el.setPointerCapture?.(e.pointerId);
    this.y.stop(); // caught mid-flight: it stays where it is, under the pointer
    const startY = e.clientY;
    const from = this.y.value;
    const history = [{ y: e.clientY, t: e.timeStamp }];
    let moved = false;
    const move = (ev) => {
      const dy = ev.clientY - startY;
      if (Math.abs(dy) > 6) moved = true;
      history.push({ y: ev.clientY, t: ev.timeStamp });
      if (history.length > 6) history.shift();
      const y = from + dy;
      this.y.jump(y > 0 ? rubberband(y, el.offsetHeight) : y);
    };
    const up = (ev) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (!moved) {
        this.hide();
        this.onClose();
        return;
      }
      const first = history[0];
      const last = history[history.length - 1];
      const dt = Math.max(1, last.t - first.t);
      const velocity = ((last.y - first.y) / dt) * 1000; // px/s
      const landing = this.y.value + project(velocity);
      if (landing < this.away / 2 || (ev.type === "pointerup" && velocity < -400)) {
        this.hide({ velocity });
        this.onClose();
      } else {
        this.y.set(0, { velocity, response: 0.4, damping: 0.85 }); // a flick that didn't make it: a little bounce
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }
}
