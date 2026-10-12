FROM node:20-alpine
WORKDIR /app
COPY arena-server.js backtest-arena.html package.json ./
COPY data ./data
ENV PORT=3000 DATA_DIR=/data TRUST_PROXY=1 NODE_ENV=production
VOLUME /data
EXPOSE 3000
CMD ["node", "arena-server.js"]
