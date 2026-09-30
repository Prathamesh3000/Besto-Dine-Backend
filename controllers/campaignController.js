const Campaign = require('../models/campaign');
const logger = require('../utils/logger');

const { tenantFilter, tenantId, strictBranchFilter, pinnedBranchId } = require('../utils/tenantScope');

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

    // Pinned admin's campaigns are owned by their branch. Tenant owner
    // can target a specific branch via req.body.branch, or leave it
    // null for a tenant-level campaign.
    const pinned = pinnedBranchId(req);
    const ownerBranch = pinned || req.body.branch || null;

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
    const updates = { ...req.body };
    // Prevent tenant hopping via body, and prevent a pinned admin from
    // re-assigning the campaign to another branch.
    delete updates.restaurant;
    if (pinnedBranchId(req)) delete updates.branch;

    const campaign = await Campaign.findOneAndUpdate(
      { _id: id, ...tenantFilter(req), ...strictBranchFilter(req) },
      updates,
      { returnDocument: 'after', runValidators: true }
    );
    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    res.status(200).json({ success: true, campaign });
  } catch (error) {
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
