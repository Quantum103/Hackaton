package database

import (
	"database/sql"
	"log"

	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

func Init(dbPath string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}

	// Проверка соединения
	if err := db.Ping(); err != nil {
		return nil, err
	}

	// Создание таблиц
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS admins (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			email TEXT UNIQUE NOT NULL,
			password TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			login TEXT UNIQUE NOT NULL,
			password TEXT NOT NULL
		);
	`)
	if err != nil {
		return nil, err
	}

	// Сидирование админа
	var count int
	db.QueryRow("SELECT COUNT(*) FROM admins").Scan(&count)
	if count == 0 {
		hashedPass, _ := bcrypt.GenerateFromPassword([]byte("admin123"), bcrypt.DefaultCost)
		_, err = db.Exec("INSERT INTO admins (name, email, password) VALUES (?, ?, ?)",
			"Super Admin", "admin@gmail.com", string(hashedPass))
		if err != nil {
			return nil, err
		}
		log.Println("✅ Создан дефолтный админ: admin@gmail.com / admin123")
	}

	return db, nil
}
