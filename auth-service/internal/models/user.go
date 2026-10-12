package models

type Admin struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"-"` // Скрыто при отправке в JSON
}

type User struct {
	ID       int    `json:"id"`
	Login    string `json:"login"`
	Password string `json:"-"` // Скрыто при отправке в JSON
}

type AdminLoginReq struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type UserLoginReq struct {
	Login    string `json:"login"`
	Password string `json:"password"`
}

type RegisterUserReq struct {
	Login    string `json:"login"`
	Password string `json:"password"`
}

type AuthResponse struct {
	Token string `json:"token"`
	Role  string `json:"role"`
	Name  string `json:"name"`
}

type ErrorResponse struct {
	Error string `json:"error"`
}
