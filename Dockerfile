FROM ghcr.io/puppeteer/puppeteer:23.4.0

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# Copy as root, then switch
USER root
COPY package.json .
RUN npm install --production
COPY . .

# Run as non-root pptruser (built into the image)
USER pptruser
EXPOSE ${PORT:-4003}
CMD ["node", "server.js"]
