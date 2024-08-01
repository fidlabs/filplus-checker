/* global exports:writable */

/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('allocator_generated_reports', {
    id: 'id',
    address: { type: 'text', notNull: true },
    address_id: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    url: { type: 'text', notNull: true },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('allocator_generated_reports', 'address');
  pgm.createIndex('allocator_generated_reports', 'address_id');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropIndex('allocator_generated_reports', 'address');
  pgm.dropIndex('allocator_generated_reports', 'address_id');
  pgm.dropTable('allocator_generated_reports');
};
