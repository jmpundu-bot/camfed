const { neon } = require('@neondatabase/serverless');

let sql;

function getSql() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is not configured.');
  }

  if (!sql) sql = neon(connectionString);
  return sql;
}

module.exports = { getSql };
