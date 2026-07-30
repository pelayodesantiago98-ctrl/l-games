#!/usr/bin/env node
'use strict';

/*
 * Alta o cambio de contraseña de un usuario de L-games.
 *
 *   node adduser.js <usuario> <contraseña>
 *
 * Si el usuario ya existe se le reemplaza la contraseña. Las sesiones abiertas
 * siguen siendo válidas: para invalidarlas hay que rotar SESSION_SECRET.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [, , username, password] = process.argv;

if (!username || !password) {
  console.error('Uso: node adduser.js <usuario> <contraseña>');
  process.exit(1);
}

if (password.length < 8) {
  console.error('La contraseña debe tener al menos 8 caracteres.');
  process.exit(1);
}

const file = path.join(__dirname, 'config', 'users.json');

let users = {};
if (fs.existsSync(file)) {
  try {
    users = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`No se pudo leer ${file}: ${err.message}`);
    process.exit(1);
  }
}

const existia = Object.prototype.hasOwnProperty.call(users, username);
const salt = crypto.randomBytes(16).toString('hex');

users[username] = {
  salt,
  hash: crypto.scryptSync(password, salt, 64).toString('hex'),
  creado: existia ? users[username].creado : new Date().toISOString(),
};

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(users, null, 2) + '\n', { mode: 0o640 });

console.log(existia ? `Contraseña actualizada para "${username}".` : `Usuario "${username}" creado.`);
console.log(`Usuarios en total: ${Object.keys(users).length}`);
