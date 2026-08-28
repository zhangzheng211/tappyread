require('dotenv').config();

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./db');

function parseCsvRow(line) {
  return line.replace(/^\uFEFF/, '').split(',').map(value => value.trim().replace(/^"|"$/g, ''));
}

async function main() {
  const filePath = process.argv[2] || path.resolve(__dirname, '..', 'user');
  const rows = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map(row => row.trim()).filter(Boolean);
  if (rows.length < 2) throw new Error('user 文件没有可导入的账号');
  const headers = parseCsvRow(rows[0]).map(header => header.toLowerCase());
  const usernameIndex = headers.indexOf('username');
  const passwordIndex = headers.indexOf('password');
  const accounts = usernameIndex >= 0 && passwordIndex >= 0
    ? rows.slice(1).map(row => parseCsvRow(row)).map(values => ({ username: values[usernameIndex], password: values[passwordIndex] }))
    : rows.map(parseCsvRow).map(values => ({ username: values[0], password: values[1] }));

  for (const account of accounts.filter(item => item.username && item.password && item.username !== 'username')) {
    const passwordHash = await bcrypt.hash(account.password, 12);
    await pool.execute(
      `INSERT INTO users (username, password_hash) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
      [account.username, passwordHash]
    );
    console.log(`已导入账号: ${account.username}`);
  }
  await pool.end();
}

main().catch(async error => {
  console.error(error.message);
  await pool.end();
  process.exitCode = 1;
});
