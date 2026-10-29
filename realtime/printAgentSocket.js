'use strict';
/**
 * Socket handlers for a connected print agent (socket.data.agent set by
 * the handshake in utils/socket.js). The agent sits only in its branch's
 * printer room; it has no role and no user, so nothing here may rely on
 * the tenant request context — every query goes through printService
 * with the explicit restaurant / branch from the token.
 *
 * Client → server:
 *   print:pending (cb)                → cb({ ok, jobs:[wireJob] })   jobs still to print
 *   print:ack { jobId, status, error } (cb) → cb({ ok })              done | failed
 * Server → agent:  print:job (wireJob)          (emitted by printService.dispatch)
 * Server → admin:  print:agent-status, print:job-updated
 */
const EVENTS = require('./events');
const logger = require('../utils/logger');
const printService = require('../services/printService');
const { printerRoom } = require('../utils/socketRooms');
const { runAsTenant } = require('../utils/tenantSafe');

function attach(socket) {
    const { restaurant, branch, agentId } = socket.data.agent;
    const io = socket.server;
    const room = printerRoom(restaurant, branch);

    const status = (online) => {
        try {
            const { emitToAdmin } = require('../utils/socket');
            emitToAdmin(io, branch, EVENTS.PRINT_AGENT_STATUS, { online, agentId, restaurant, branch, at: Date.now() });
        } catch { /* socket not critical */ }
    };

    printService.markAgentSeen(restaurant, branch);
    status(true);
    logger.info(`print-agent connected: tenant ${restaurant} branch ${branch} agent ${agentId}`);

    socket.on('print:pending', async (cb) => {
        const reply = typeof cb === 'function' ? cb : () => {};
        try {
            const jobs = await runAsTenant(restaurant, () => printService.listPending(restaurant, branch));
            reply({ ok: true, jobs });
        } catch (err) {
            logger.warn(`print-agent pending failed: ${err.message}`);
            reply({ ok: false, jobs: [] });
        }
    });

    socket.on('print:ack', async (payload, cb) => {
        const reply = typeof cb === 'function' ? cb : () => {};
        try {
            const { jobId, status: st, error } = payload || {};
            if (typeof jobId !== 'string' || !/^[a-f0-9]{24}$/i.test(jobId)) return reply({ ok: false, code: 'BAD_JOB_ID' });
            const job = await runAsTenant(restaurant, () => printService.ackJob(restaurant, branch, jobId, st, error));
            printService.markAgentSeen(restaurant, branch);
            reply({ ok: !!job, code: job ? undefined : 'NOT_FOUND' });
        } catch (err) {
            logger.warn(`print-agent ack failed: ${err.message}`);
            reply({ ok: false, code: 'ERROR' });
        }
    });

    socket.on('disconnect', async () => {
        try {
            const remaining = room ? await io.in(room).fetchSockets() : [];
            if (remaining.length === 0) status(false);
        } catch {
            status(false);
        }
        printService.markAgentSeen(restaurant, branch);
    });
}

module.exports = { attach };
