const mongoose = require('mongoose');

const reservationSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Phase 6 branch-scoping: optional branch link. null = tenant-
    // level (the default for single-location tenants and for every
    // doc created before this migration).
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
    // The customer account that made this booking, when it came from
    // the customer-facing flow. null for staff-entered reservations
    // (a waiter booking a phone-in walk-in has no user to link).
    // Indexed because the customer flow counts a user's open bookings
    // on every create to cap floor-hogging.
    bookedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
        index: true,
    },
    guestName: {
        type: String,
        required: [true, 'Guest name is required'],
        trim: true
    },
    contactNo: {
        type: String,
        required: [true, 'Contact number is required'],
        trim: true
    },
    date: {
        type: Date,
        default: Date.now // Assuming today since there's no date picker in the form yet
    },
    time: {
        type: String,
        required: [true, 'Reservation time is required']
    },
    guestCount: {
        type: Number,
        required: [true, 'Guest count is required'],
        min: [1, 'Must have at least 1 guest']
    },
    area: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Area',
        required: false // Optional for hall bookings
    },
    table: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Table',
        required: false // Optional for hall bookings
    },
    // Phase 3: Advanced Booking Fields
    bookingType: {
        type: String,
        enum: ['table', 'hall'],
        default: 'table'
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    hall: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Hall'
    },
    tables: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Table'
    }],
    eventDetails: {
        cake: {
            flavor: String,
            size: String,
            isVeg: Boolean,
            message: String,
            quantity: Number
        },
        decoration: {
            id: String,
            title: String,
            price: Number
        },
        addOns: [{
            id: String,
            title: String,
            price: Number,
            options: [String]
        }],
        menuPackage: {
            id: String,
            name: String,
            price: Number
        },
        parking: {
            vehicleType: String,
            count: Number
        }
    },
    payment: {
        total: Number,
        advancePaid: Number,
        balance: Number,
        method: String,
        status: {
            type: String,
            enum: ['pending', 'partial', 'paid'],
            default: 'pending'
        }
    },
    notes: {
        type: String,
        trim: true
    },
    status: {
        type: String,
        enum: ['Pending', 'Approved', 'Rejected', 'Seated', 'Cancelled', 'Completed'],
        default: 'Pending'
    }

}, {
    timestamps: true
});

reservationSchema.index({ user: 1, date: -1 });
reservationSchema.index({ status: 1, createdAt: -1 });
reservationSchema.index({ date: 1 });
reservationSchema.index({ table: 1, date: 1 });  // Conflict detection + table lookups
reservationSchema.index({ status: 1, date: 1 });  // Filtered date-range queries
// Branch-scoped admin bookings list — admin Bookings page filters by
// (tenant, branch, date) when paging through reservations for a branch.
reservationSchema.index({ restaurant: 1, branch: 1, date: 1 });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
reservationSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Reservation', reservationSchema);
