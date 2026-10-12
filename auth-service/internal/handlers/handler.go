package handlers

import (
	"auth-service/internal/models"
	"database/sql"
	"encoding/json"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

var jwtSecret = []byte("super_secret_hackaton_key_2026")

// API хранит зависимости (например, базу данных)
type API struct {
	DB *sql.DB
}

func (a *API) sendJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func (a *API) AdminLogin(w http.ResponseWriter, r *http.Request) {
	var req models.AdminLoginReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.sendJSON(w, http.StatusBadRequest, models.ErrorResponse{Error: "Invalid JSON"})
		return
	}

	var admin models.Admin
	err := a.DB.QueryRow("SELECT id, name, email, password FROM admins WHERE email = ?", req.Email).
		Scan(&admin.ID, &admin.Name, &admin.Email, &admin.Password)

	if err != nil || bcrypt.CompareHashAndPassword([]byte(admin.Password), []byte(req.Password)) != nil {
		a.sendJSON(w, http.StatusUnauthorized, models.ErrorResponse{Error: "Invalid email or password"})
		return
	}

	token := generateToken(admin.ID, "admin")
	a.sendJSON(w, http.StatusOK, models.AuthResponse{Token: token, Role: "admin", Name: admin.Name})
}

func (a *API) AdminRegisterUser(w http.ResponseWriter, r *http.Request) {
	var req models.RegisterUserReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.sendJSON(w, http.StatusBadRequest, models.ErrorResponse{Error: "Invalid JSON"})
		return
	}

	hashedPass, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		a.sendJSON(w, http.StatusInternalServerError, models.ErrorResponse{Error: "Internal error"})
		return
	}

	_, err = a.DB.Exec("INSERT INTO users (login, password) VALUES (?, ?)", req.Login, string(hashedPass))
	if err != nil {
		a.sendJSON(w, http.StatusConflict, models.ErrorResponse{Error: "User already exists"})
		return
	}

	a.sendJSON(w, http.StatusCreated, map[string]string{"message": "User created successfully"})
}

func (a *API) UserLogin(w http.ResponseWriter, r *http.Request) {
	var req models.UserLoginReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		a.sendJSON(w, http.StatusBadRequest, models.ErrorResponse{Error: "Invalid JSON"})
		return
	}

	var user models.User
	err := a.DB.QueryRow("SELECT id, login, password FROM users WHERE login = ?", req.Login).
		Scan(&user.ID, &user.Login, &user.Password)

	if err != nil || bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(req.Password)) != nil {
		a.sendJSON(w, http.StatusUnauthorized, models.ErrorResponse{Error: "Invalid login or password"})
		return
	}

	token := generateToken(user.ID, "user")
	a.sendJSON(w, http.StatusOK, models.AuthResponse{Token: token, Role: "user", Name: user.Login})
}

func generateToken(userID int, role string) string {
	claims := jwt.MapClaims{
		"user_id": userID,
		"role":    role,
		"exp":     time.Now().Add(time.Hour * 24).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, _ := token.SignedString(jwtSecret)
	return tokenString
}
