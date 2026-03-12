// Комментарий: ВРЕМЕННЫЙ СКРИПТ ДЛЯ ГЕНЕРАЦИИ ХЕША ПАРОЛЯ
// Запусти его один раз через терминал: node hash.js
const bcrypt = require('bcrypt');

const myPassword = 'твой_текущий_пароль_здесь'; // <-- Впиши сюда свой пароль
const saltRounds = 10;

bcrypt.hash(myPassword, saltRounds, function(err, hash) {
    if (err) throw err;
    console.log('Твой новый зашифрованный пароль для базы данных:');
    console.log(hash);
});