// Minimal stand-in for the "cloudflare:workers" module so Durable Object classes can run under Node tests.
export class DurableObject {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
