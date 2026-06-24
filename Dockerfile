FROM node:20-bookworm

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install npm dependencies
RUN npm ci || npm install

# Install Playwright browsers and OS dependencies
RUN npx playwright install chromium --with-deps

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on (Render provides PORT via env)
ENV PORT=3456
EXPOSE 3456

# Start the application
CMD ["npm", "start"]
