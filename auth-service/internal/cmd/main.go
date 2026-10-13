package main

import (
	"auth-service/internal/database"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"auth-service/internal/handlers"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
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
	if err := os.MkdirAll(filepath.Dir(dbPath), 0755); err != nil {
		log.Fatalf("Не удалось создать директорию для БД: %v", err)
	}

	db, err := database.Init(dbPath)
	if err != nil {
		log.Fatalf("Ошибка инициализации БД: %v", err)
	}
	defer db.Close()

	secret, err := resolveJWTSecret(dbPath)
	if err != nil {
		log.Fatalf("Не удалось настроить секрет JWT: %v", err)
	}
	handlers.SetJWTSecret(secret)

	api := &handlers.API{DB: db}
	mux := http.NewServeMux()
	api.RegisterRoutes(mux)

	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		port = "8080"
	}
	handler := api.RevisionMiddleware(corsMiddleware(mux))
	log.Printf("Stoplist API запущен на порту %s", port)
	log.Fatal(http.ListenAndServe(":"+port, handler))
}


// resolveJWTSecret prefers an explicitly configured secret. For local Docker usage,
// it creates a strong random key in the persistent data directory so tokens remain
// valid across restarts without shipping a known secret in the compose file.
func resolveJWTSecret(dbPath string) ([]byte, error) {
	if configured := strings.TrimSpace(os.Getenv("JWT_SECRET")); configured != "" {
		if len(configured) < 32 {
			return nil, errors.New("JWT_SECRET должен содержать не менее 32 символов")
		}
		return []byte(configured), nil
	}

	secretPath := filepath.Join(filepath.Dir(dbPath), "jwt-secret")
	secret, err := os.ReadFile(secretPath)
	if err == nil {
		value := strings.TrimSpace(string(secret))
		if len(value) < 32 {
			return nil, errors.New("файл jwt-secret содержит слишком короткий ключ")
		}
		if err := os.Chmod(secretPath, 0600); err != nil {
			return nil, err
		}
		return []byte(value), nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}

	randomKey := make([]byte, 32)
	if _, err := rand.Read(randomKey); err != nil {
		return nil, err
	}
	value := hex.EncodeToString(randomKey)
	if err := os.WriteFile(secretPath, []byte(value), 0600); err != nil {
		return nil, err
	}
	return []byte(value), nil
}
