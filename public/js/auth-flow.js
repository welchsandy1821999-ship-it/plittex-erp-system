const Auth = {
    login: async () => {
        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value.trim();
        const errorDiv = document.getElementById('login-error');

        if (!username || !password) {
            errorDiv.innerText = 'Введите логин и пароль';
            return;
        }

        errorDiv.innerText = 'Проверка...';

        try {
            // 🔑 /api/login не требует JWT — используем fetch напрямую
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            const data = await res.json();

            if (res.ok && data.token) {
                // Сохраняем данные
                localStorage.setItem('token', data.token);
                localStorage.setItem('jwtToken', data.token); // Для обратной совместимости
                localStorage.setItem('user', JSON.stringify(data.user));

                // Очищаем форму
                document.getElementById('login-password').value = '';
                errorDiv.innerText = '';

                // Скрываем экран логина и показываем ERP
                document.documentElement.classList.remove('auth-required');

                // Запускаем инициализацию интерфейса
                if (typeof window.startApp === 'function') {
                    window.startApp();
                }
            } else {
                errorDiv.innerText = data.error || 'Ошибка авторизации';
            }
        } catch (err) {
            errorDiv.innerText = 'Ошибка соединения с сервером';
            console.error('Login Error:', err);
        }
    },

    logout: () => {
        // Очищаем хранилище
        localStorage.removeItem('token');
        localStorage.removeItem('jwtToken');
        localStorage.removeItem('user');

        // Показываем экран логина обратно
        document.documentElement.classList.add('auth-required');
    }
};

// Для старого кода, который мог вызывать window.logout()
window.logout = Auth.logout;
window.handleLogout = Auth.logout;