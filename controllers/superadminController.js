// Super Admin controller: thin aggregator (task 4.7). The handlers live in
// controllers/superadmin/*.js, grouped by concern; shared helpers in
// controllers/superadmin/_shared.js. This module re-exports every handler so
// routes/superadminRoute.js (and anything mocking this path) is unchanged.
module.exports = {
    ...require('./superadmin/restaurants'),
    ...require('./superadmin/restaurantCreate'),
    ...require('./superadmin/subscriptions'),
    ...require('./superadmin/plans'),
    ...require('./superadmin/addons'),
    ...require('./superadmin/analytics'),
    ...require('./superadmin/auditLogs'),
    ...require('./superadmin/approvals'),
    ...require('./superadmin/planChangeRequests'),
    ...require('./superadmin/approvalDetail'),
    ...require('./superadmin/leads'),
    ...require('./superadmin/marketing'),
    ...require('./superadmin/billing'),
};
