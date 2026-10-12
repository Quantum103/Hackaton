package main

import (
	"auth-service/internal/database"
	"auth-service/internal/handlers"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	dbPath := os.Getenv("SQLITE_DB_PATH")
	if dbPath == "" {
		dbPath = "./data/app.db"
	}

	// Создаем папку для БД
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		log.Fatalf("Не удалось создать директорию для БД: %v", err)
	}

	// 1. Инициализируем БД и получаем объект *sql.DB
	db, err := database.Init(dbPath)
	if err != nil {
		log.Fatalf("Ошибка инициализации БД: %v", err)
	}
	defer db.Close()

	// 2. Создаем экземпляр API, передавая ему базу данных
	api := &handlers.API{DB: db}

	// 3. Настраиваем роуты, вызывая методы нашего api
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/admin/login", api.AdminLogin)
	mux.HandleFunc("POST /api/admin/users", api.AdminRegisterUser)
	mux.HandleFunc("POST /api/user/login", api.UserLogin)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	})

	// 4. Запускаем сервер с CORS
	handler := corsMiddleware(mux)
	log.Println("🚀 Сервер запущен на порту 8080")
	log.Fatal(http.ListenAndServe(":8080", handler))
}
