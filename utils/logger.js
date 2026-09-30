const path = require('path');
const winston = require('winston');
const config = require('../config');

// Always write to Backend/logs regardless of the cwd the process started in.
const LOG_DIR = path.join(__dirname, '..', 'logs');

// Size-based rotation: each file is capped at MAX_SIZE; when full, winston
// renames it (combined1.log, combined2.log, …) and keeps at most MAX_FILES,
// deleting the oldest. `tailable` keeps the newest lines in the base
// filename. Worst case on disk: (5 + 3) × 10 MB = 80 MB.
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

const logger = winston.createLogger({
    level: config.logLevel,
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            silent: config.isProduction,
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            ),
        }),
        new winston.transports.File({
            filename: path.join(LOG_DIR, 'error.log'),
            level: 'error',
            maxsize: MAX_SIZE,
            maxFiles: 3,
            tailable: true,
        }),
        new winston.transports.File({
            filename: path.join(LOG_DIR, 'combined.log'),
            maxsize: MAX_SIZE,
            maxFiles: 5,
            tailable: true,
        }),
    ],
});

module.exports = logger;
