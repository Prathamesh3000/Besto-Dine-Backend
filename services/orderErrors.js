/**
 * orderErrors — the tiny HTTP contract between the order services and
 * controllers/orderController.js.
 *
 * Services never touch `res`. A service either
 *   • returns a result  → `reply(status, body, after?)`, or
 *   • throws an early-exit response → `httpError(status, body)`.
 *
 * The controller sends `result.body` with `result.status`, then runs the
 * optional `after` tasks (post-response notifications / socket fan-out).
 * An OrderHttpError is sent verbatim as `res.status(err.status).json(err.body)`,
 * so every 4xx body is byte-for-byte what the handler used to send inline.
 */

class OrderHttpError extends Error {
  constructor(status, body) {
    super((body && body.message) || `HTTP ${status}`);
    this.name = 'OrderHttpError';
    this.status = status;
    this.body = body;
  }
}

const httpError = (status, body) => new OrderHttpError(status, body);
const isOrderHttpError = (err) => err instanceof OrderHttpError;

/**
 * @param {number} status
 * @param {object} body
 * @param {Array<[string, Function]>} [after] post-response tasks, run via
 *        runAfterResponse(label, fn) once the response has been sent.
 */
const reply = (status, body, after) => ({ status, body, after: after || [] });

module.exports = { OrderHttpError, httpError, isOrderHttpError, reply };
