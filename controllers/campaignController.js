const Campaign = require('../models/campaign');
const logger = require('../utils/logger');

const { tenantFilter, tenantId, strictBranchFilter, pinnedBranchId } = require('../utils/tenantScope');
const { resolveOwnedBranch } = require('../utils/branchOwnership');

const CAMPAIGN_TYPES = ['birthday', 'custom', 'first_order', 'referral'];
// Client-writable fields on update. Server counters (totalPointsIssued,
// customersAffected), createdBy and restaurant are never taken from the body.
const CAMPAIGN_UPDATE_FIELDS = ['name', 'description', 'type', 'points', 'startDate', 'endDate', 'enabled', 'branch'];

const isBlank = (v) => v === null || v === undefined || v === '';
const badDate = (v) => !isBlank(v) && Number.isNaN(new Date(v).getTime());

// Shared field checks for create / update (on the merged campaign for
// update). Returns the first failure message or null.
function validateCampaign({ type, startDate, endDate }) {
  if (type !== undefined && !CAMPAIGN_TYPES.includes(type)) return 'Invalid campaign type';
  if (badDate(startDate) || badDate(endDate)) return 'Start / end date must be valid dates';
  if (!isBlank(startDate) && !isBlank(endDate) && new Date(endDate) < new Date(startDate)) {
    return 'End date cannot be before start date';
  }
  return null;
}

// Mongoose validation / cast failures are client input errors → 400.
const isClientError = (error) => error && (error.name === 'ValidationError' || error.name === 'CastError');

// Get all campaigns
exports.getCampaigns = async (req, res) => {
  try {
    // Branch-pinned admin sees ONLY their branch's Bonus Points
    // campaigns. Previously the list pulled every tenant-level
    // (branch:null) campaign into every branch admin's view — the
    // "Bonus Points leak" the user reported.
    const campaigns = await Campaign.find({ ...tenantFilter(req), ...strictBranchFilter(req) }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, campaigns });
  } catch (error) {
    logger.error('Error fetching campaigns:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch campaigns' });
  }
};

// Create a campaign
exports.createCampaign = async (req, res) => {
  try {
    const { name, description, type, points, startDate, endDate } = req.body;

    if (!name || !points) {
      return res.status(400).json({ success: false, message: 'Name and points are required' });
    }

    const pts = parseInt(points);
    if (isNaN(pts) || pts <= 0) {
      return res.status(400).json({ success: false, message: 'Points must be a positive number' });
    }

    if (type === 'custom' && (!startDate || !endDate)) {
      return res.status(400).json({ success: false, message: 'Custom campaigns require start and end dates' });
    }
    const invalid = validateCampaign({ type, startDate, endDate });
    if (invalid) return res.status(400).json({ success: false, message: invalid });

    // Pinned admin's campaigns are owned by their branch (body ignored).
    // Tenant owner can target a branch of THIS tenant via req.body.branch,
    // or leave it null for a tenant-level campaign.
    const pinned = pinnedBranchId(req);
    let ownerBranch = pinned || null;
    if (!pinned) {
      const branchCheck = await resolveOwnedBranch(req, req.body.branch);
      if (!branchCheck.ok) {
        return res.status(branchCheck.status).json({ success: false, ...(branchCheck.code && { code: branchCheck.code }), message: branchCheck.message });
      }
      ownerBranch = branchCheck.branchId;
    }

    const campaign = new Campaign({
      name,
      description: description || '',
      type: type || 'custom',
      points: pts,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      enabled: true,
      createdBy: req.user.id,
      restaurant: tenantId(req),
      branch: ownerBranch,
    });

    await campaign.save();
    res.status(201).json({ success: true, campaign });
  } catch (error) {
    if (isClientError(error)) return res.status(400).json({ success: false, message: error.message });
    logger.error('Error creating campaign:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to create campaign' });
  }
};

// Toggle campaign enabled/disabled
exports.toggleCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const campaign = await Campaign.findOne({ _id: id, ...tenantFilter(req), ...strictBranchFilter(req) });
    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    campaign.enabled = !campaign.enabled;
    await campaign.save();
    res.status(200).json({ success: true, campaign });
  } catch (error) {
    logger.error('Error toggling campaign:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to toggle campaign' });
  }
};

// Update a campaign
exports.updateCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    // Allowlist — restaurant (tenant hop), server counters and createdBy
    // are never writable; a pinned admin cannot re-assign the branch.
    const updates = {};
    for (const k of CAMPAIGN_UPDATE_FIELDS) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) updates[k] = req.body[k];
    }
    if (pinnedBranchId(req)) delete updates.branch;
    else if (Object.prototype.hasOwnProperty.call(updates, 'branch')) {
      const branchCheck = await resolveOwnedBranch(req, updates.branch);
      if (!branchCheck.ok) {
        return res.status(branchCheck.status).json({ success: false, ...(branchCheck.code && { code: branchCheck.code }), message: branchCheck.message });
      }
      updates.branch = branchCheck.branchId;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'points')) {
      const pts = parseInt(updates.points);
      if (isNaN(pts) || pts <= 0) {
        return res.status(400).json({ success: false, message: 'Points must be a positive number' });
      }
      updates.points = pts;
    }

    const filter = { _id: id, ...tenantFilter(req), ...strictBranchFilter(req) };
    const existing = await Campaign.findOne(filter).lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }
    // Validate the MERGED campaign so a lone endDate can't precede the stored startDate.
    const invalid = validateCampaign({ ...existing, ...updates });
    if (invalid) return res.status(400).json({ success: false, message: invalid });

    // AUDIT-EXEMPT: `filter` = { _id, ...tenantFilter(req), ...strictBranchFilter(req) } above
    const campaign = await Campaign.findOneAndUpdate(
      filter,
      updates,
      { returnDocument: 'after', runValidators: true }
    );
    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    res.status(200).json({ success: true, campaign });
  } catch (error) {
    if (isClientError(error)) return res.status(400).json({ success: false, message: error.message });
    logger.error('Error updating campaign:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update campaign' });
  }
};

// Delete a campaign
exports.deleteCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const campaign = await Campaign.findOneAndDelete({ _id: id, ...tenantFilter(req), ...strictBranchFilter(req) });
    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }
    res.status(200).json({ success: true, message: 'Campaign deleted' });
  } catch (error) {
    logger.error('Error deleting campaign:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to delete campaign' });
  }
};

// Get campaign stats summary
exports.getCampaignStats = async (req, res) => {
  try {
    // Stats must mirror the list filter — pinned admin sees only their
    // own branch's campaign counts and points.
    const filter = { ...tenantFilter(req), ...strictBranchFilter(req) };
    const activeCampaigns = await Campaign.countDocuments({ enabled: true, ...filter });
    const totalCampaigns  = await Campaign.countDocuments(filter);

    const agg = await Campaign.aggregate([
      { $match: filter },
      { $group: { _id: null, totalPointsIssued: { $sum: '$totalPointsIssued' }, totalCustomers: { $sum: '$customersAffected' } } }
    ]);

    const stats = agg[0] || { totalPointsIssued: 0, totalCustomers: 0 };

    res.status(200).json({
      success: true,
      stats: {
        activeCampaigns,
        totalCampaigns,
        totalPointsIssued: stats.totalPointsIssued,
        totalCustomersImpacted: stats.totalCustomers
      }
    });
  } catch (error) {
    logger.error('Error fetching campaign stats:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch campaign stats' });
  }
};
