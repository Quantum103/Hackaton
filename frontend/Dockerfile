FROM nginx:alpine

# Копируем все файлы из папки frontend (html, css, js, nginx.conf) в nginx
COPY . /usr/share/nginx/html

# Явно указываем, что берем конфиг из текущей папки сборки
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]