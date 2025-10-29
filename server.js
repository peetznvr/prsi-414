// server.js
const WebSocket = require('ws');
const http = require('http');
const url = require('url');

// Pomocné funkce
const RANK_SEVEN = 0;
const RANK_QUEEN = 5;
const RANK_ACE = 7;

function getSuit(card) {
    return Math.floor(card / 8);
}

function getRank(card) {
    return card % 8;
}

function createDeck() {
    const deck = [];
    for (let i = 0; i < 32; i++) deck.push(i);
    return deck.sort(() => Math.random() - 0.5);
}

// Hra
class Game {
    constructor() {
        this.players = []; // [{ id, ws, name, hand }]
        this.deck = [];
        this.upcard = null;
        this.toDraw = 1;
        this.currentPlayerIndex = 0;
    }

    addPlayer(ws, name) {
        const player = { id: Date.now() + Math.random(), ws, name, hand: {} };
        this.players.push(player);
        return player;
    }

    start() {
        if (this.players.length < 1) return;
        this.deck = createDeck();
        this.players.forEach(p => {
            p.hand = {};
            for (let i = 0; i < 4; i++) {
                const card = this.deck.pop();
                p.hand[card] = true;
            }
        });
        this.upcard = this.deck.pop();
        this.toDraw = (getRank(this.upcard) === RANK_SEVEN ? 2 : (getRank(this.upcard) === RANK_ACE ? 0 : 1));
        this.currentPlayerIndex = 0;
        this.broadcastState();
    }

    broadcastState() {
        const playerNames = this.players.map(p => p.name);
        this.players.forEach((player, i) => {
            const isCurrent = i === this.currentPlayerIndex;
            const otherNames = {};
            this.players.forEach((p, j) => {
                if (j !== i) {
                    otherNames[(j - i + this.players.length) % this.players.length] = p.name;
                }
            });

            const data = {
                cards: Object.keys(player.hand).map(Number),
                upcard: this.upcard,
                action: isCurrent ? (this.toDraw === 0 ? 'pass' : `draw${this.toDraw === 1 ? '' : ' ' + this.toDraw}`) : '',
                start: this.players.length,
                playing: (this.players.length - i) % this.players.length,
                names: otherNames
            };

            if (getRank(this.upcard) === RANK_QUEEN) {
                data.suit = getSuit(this.upcard);
            }

            player.ws.send(JSON.stringify(data));
        });
    }

    play(playerId, msg) {
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1) return;

        const player = this.players[playerIndex];
        if (playerIndex !== this.currentPlayerIndex) {
            player.ws.send(JSON.stringify({ message: "Not your turn." }));
            return;
        }

        if (msg.name) {
            player.name = msg.name.substring(0, 20);
            this.broadcastState();
            return;
        }

        const data = { upcard: this.upcard };
        let playedCard = null;

        if (msg.card == 32) {
            // Tah z balíčku
            const cards = [];
            for (let i = 0; i < this.toDraw && this.deck.length > 0; i++) {
                const drawn = this.deck.pop();
                player.hand[drawn] = true;
                cards.push(drawn);
            }
            if (cards.length > 0) {
                player.ws.send(JSON.stringify({ cards }));
            }
            this.toDraw = 1;
            playedCard = null;
        } else {
            const card = Number(msg.card);
            if (!player.hand[card]) {
                player.ws.send(JSON.stringify({ message: "You don't have this card." }));
                return;
            }

            // Kontrola pravidel
            if (this.toDraw > 1 && getRank(card) !== RANK_SEVEN) {
                player.ws.send(JSON.stringify({ message: "You can play only Seven on top of Seven." }));
                return;
            }
            if (this.toDraw === 0 && getRank(card) !== RANK_ACE) {
                player.ws.send(JSON.stringify({ message: "You can play only Ace on top of Ace." }));
                return;
            }
            if (this.toDraw === 1) {
                const sameSuit = getSuit(card) === getSuit(this.upcard);
                const sameRank = getRank(card) === getRank(this.upcard);
                if (!sameSuit && !sameRank) {
                    player.ws.send(JSON.stringify({ message: "You can play only a card with the same suit or rank." }));
                    return;
                }
            }

            // Hraje kartu
            delete player.hand[card];
            playedCard = card;

            if (getRank(card) === RANK_QUEEN) {
                if (msg.suit == null) {
                    player.ws.send(JSON.stringify({ message: "Choose suit." }));
                    return;
                }
                const suit = msg.suit.charCodeAt(0) - 'a'.charCodeAt(0);
                playedCard = suit * 8 + (card % 8);
                data.suit = suit;
            }

            if (getRank(card) === RANK_SEVEN) {
                this.toDraw = (this.toDraw === 1 ? 2 : this.toDraw + 2);
            } else if (getRank(card) === RANK_ACE) {
                this.toDraw = 0;
            }

            // Vrátíme starou upcard do balíčku
            this.deck.unshift(this.upcard);
        }

        if (playedCard !== null) {
            this.upcard = playedCard;
        }

        // Kontrola výhry
        const hasWon = Object.keys(player.hand).length === 0;

        // Přesun na dalšího hráče
        let nextIndex = (this.currentPlayerIndex + 1) % this.players.length;
        if (this.toDraw === 0) {
            // Eso → přeskočení
            nextIndex = (nextIndex + 1) % this.players.length;
        }
        this.currentPlayerIndex = nextIndex;

        // Odeslat stav všem
        this.players.forEach((p, i) => {
            const isNext = i === this.currentPlayerIndex;
            const payload = {
                upcard: this.upcard,
                action: isNext ? (this.toDraw === 0 ? 'pass' : `draw${this.toDraw === 1 ? '' : ' ' + this.toDraw}`) : '',
                playing: (this.players.length - i) % this.players.length,
                count: Object.keys(player.hand).length
            };

            if (data.suit !== undefined) payload.suit = data.suit;

            if (hasWon && p === player) {
                payload.message = "You won.";
            } else if (isNext) {
                payload.message = "You play.";
            }

            p.ws.send(JSON.stringify(payload));
        });
    }

    removePlayer(playerId) {
        const index = this.players.findIndex(p => p.id === playerId);
        if (index !== -1) {
            this.players.splice(index, 1);
            if (this.players.length > 0) {
                if (this.currentPlayerIndex >= this.players.length) {
                    this.currentPlayerIndex = 0;
                }
                this.broadcastState();
            }
        }
    }
}
