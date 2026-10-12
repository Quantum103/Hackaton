package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

// Экспортируемые ключи для контекста (чтобы handlers мог их читать)
type ContextKey string

const (
	UserIDKey ContextKey = "user_id"
	RoleKey   ContextKey = "role"
)

// AuthMiddleware создает мидлвар. Он принимает secret ключ извне.
func AuthMiddleware(secret []byte) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				w.Write([]byte(`{"error":"Authorization header required"}`))
				return
			}

			parts := strings.Split(authHeader, " ")
			if len(parts) != 2 || parts[0] != "Bearer" {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				w.Write([]byte(`{"error":"Invalid token format"}`))
				return
			}

			tokenString := parts[1]
			claims := jwt.MapClaims{}

			token, err := jwt.ParseWithClaims(tokenString, claims, func(token *jwt.Token) (interface{}, error) {
				return secret, nil
			})

			if err != nil || !token.Valid {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				w.Write([]byte(`{"error":"Invalid or expired token"}`))
				return
			}

			// Достаем данные и кладем в контекст
			userID, ok1 := claims["user_id"].(float64)
			role, ok2 := claims["role"].(string)

			if !ok1 || !ok2 {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				w.Write([]byte(`{"error":"Invalid token claims"}`))
				return
			}

			// Создаем новый контекст и передаем управление следующему хендлеру
			ctx := context.WithValue(r.Context(), UserIDKey, int(userID))
			ctx = context.WithValue(ctx, RoleKey, role)

			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
