FROM node:14

WORKDIR /app
COPY . .

ENV TZ=America/Los_Angeles

# warm cache for github.com in known_hosts
RUN mkdir ~/.ssh
RUN ssh-keyscan -Ht ecdsa github.com >> ~/.ssh/known_hosts

# install dependencies
RUN npm install

# instructions on how to start - this does not fire at image build time
CMD ["node", "app.mjs"]
