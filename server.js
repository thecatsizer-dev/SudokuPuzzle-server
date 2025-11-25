// server.js - BACKEND SOCKET.IO PRODUCTION READY v14 - FIX FLY.IO
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// ✅✅✅ CONFIGURATION SOCKET.IO OPTIMISÉE POUR FLY.IO
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 10000,        // ✅ 45s → 10s (FLY.IO)
  upgradeTimeout: 10000,        // ✅ 30s → 10s (FLY.IO)
  serveClient: false,
  perMessageDeflate: false      // ✅ AJOUTÉ (stabilité)
});

app.use(cors());
app.use(express.json());

// ========== STRUCTURES DE DONNÉES ==========

const rooms = {};

const queues = {
  classic: {
    easy: [],
    medium: [],
    hard: [],
    expert: []
  },
  powerup: {
    easy: [],
    medium: [],
    hard: [],
    expert: []
  },
  timeAttackClassic: {
    easy: [],
    medium: [],
    hard: [],
    expert: []
  },
  timeAttackPowerup: {
    easy: [],
    medium: [],
    hard: [],
    expert: []
  }
};

const connectedSockets = {};
const disconnectedPlayers = {};
const finishedGames = {};

// ✅ FLAG SERVEUR PRÊT (FLY.IO)
let isServerReady = false;

const INACTIVITY_TIMEOUT = 3 * 60 * 1000;
const RECONNECT_TIMEOUT = 60000;
const FINISHED_GAME_TTL = 5 * 60 * 1000;
const TIME_ATTACK_DURATIONS = {
  timeAttackClassic: 5 * 60 * 1000,
  timeAttackPowerup: 3 * 60 * 1000
};

// ✅ Cleanup automatique
setInterval(() => {
  const now = Date.now();
  for (const playerId in finishedGames) {
    if (now - finishedGames[playerId].timestamp > FINISHED_GAME_TTL) {
      delete finishedGames[playerId];
      console.log(`🧹 Partie terminée supprimée pour ${playerId}`);
    }
  }
}, 60000);

// ========== HELPER FUNCTIONS (INCHANGÉES) ==========

function generateRoomId() {
  return 'room_' + Math.random().toString(36).substr(2, 9);
}

function getOpponentSocketId(roomId, playerId) {
  const room = rooms[roomId];
  if (!room) return null;
  
  const opponentId = Object.keys(room.players).find(id => id !== playerId);
  return connectedSockets[opponentId];
}

function calculateProgress(grid) {
  let filled = 0;
  for (let row of grid) {
    for (let cell of row) {
      if (cell !== 0) filled++;
    }
  }
  return filled;
}

function calculateScore(player, timeInSeconds) {
  const baseScore = 1000;
  const timeBonus = Math.max(0, 3600 - timeInSeconds);
  const errorPenalty = player.errors * 50;
  const comboBonus = player.combo * 10;
  
  return Math.max(0, baseScore + timeBonus - errorPenalty + comboBonus);
}

function calculateTimeAttackScore(player) {
  let score = 0;
  
  score += player.correctMoves * 10;
  score += player.combo * 2;
  score -= player.errors * 5;
  
  if (player.progress >= 81 || player.completedEarly) {
    score += 500;
  }
  
  return Math.max(0, score);
}

function calculateFinalScore(room, player) {
  const isTimeAttack = room.gameMode.startsWith('timeAttack');
  
  if (isTimeAttack) {
    return calculateTimeAttackScore(player);
  } else {
    const elapsed = (Date.now() - room.startTime) / 1000;
    return calculateScore(player, elapsed);
  }
}

function getDifficultyConfig(difficulty) {
  const configs = {
    easy: { cellsToRemove: 35, name: 'easy' },
    medium: { cellsToRemove: 45, name: 'medium' },
    hard: { cellsToRemove: 55, name: 'hard' },
    expert: { cellsToRemove: 65, name: 'expert' }
  };
  
  return configs[difficulty] || configs.medium;
}

function generateSudokuPuzzle(difficulty) {
  const baseGrid = [
    [5, 3, 4, 6, 7, 8, 9, 1, 2],
    [6, 7, 2, 1, 9, 5, 3, 4, 8],
    [1, 9, 8, 3, 4, 2, 5, 6, 7],
    [8, 5, 9, 7, 6, 1, 4, 2, 3],
    [4, 2, 6, 8, 5, 3, 7, 9, 1],
    [7, 1, 3, 9, 2, 4, 8, 5, 6],
    [9, 6, 1, 5, 3, 7, 2, 8, 4],
    [2, 8, 7, 4, 1, 9, 6, 3, 5],
    [3, 4, 5, 2, 8, 6, 1, 7, 9]
  ];
  
  const puzzle = JSON.parse(JSON.stringify(baseGrid));
  const config = getDifficultyConfig(difficulty);
  
  let removed = 0;
  const attempts = new Set();
  
  while (removed < config.cellsToRemove && attempts.size < 81) {
    const row = Math.floor(Math.random() * 9);
    const col = Math.floor(Math.random() * 9);
    const key = `${row}-${col}`;
    
    if (!attempts.has(key) && puzzle[row][col] !== 0) {
      puzzle[row][col] = 0;
      removed++;
      attempts.add(key);
    }
  }
  
  console.log(`🎲 Puzzle ${difficulty}: ${removed} cases retirées`);
  return puzzle;
}

function getSolution() {
  return [
    [5, 3, 4, 6, 7, 8, 9, 1, 2],
    [6, 7, 2, 1, 9, 5, 3, 4, 8],
    [1, 9, 8, 3, 4, 2, 5, 6, 7],
    [8, 5, 9, 7, 6, 1, 4, 2, 3],
    [4, 2, 6, 8, 5, 3, 7, 9, 1],
    [7, 1, 3, 9, 2, 4, 8, 5, 6],
    [9, 6, 1, 5, 3, 7, 2, 8, 4],
    [2, 8, 7, 4, 1, 9, 6, 3, 5],
    [3, 4, 5, 2, 8, 6, 1, 7, 9]
  ];
}

function setupPlayerInactivityTimer(roomId, playerId) {
  const room = rooms[roomId];
  if (!room) return;
  
  const player = room.players[playerId];
  if (!player) return;
  
  if (player.inactivityTimer) {
    clearTimeout(player.inactivityTimer);
  }
  
  player.inactivityTimer = setTimeout(() => {
    console.log(`⏰ INACTIVITÉ 3min - ${player.playerName} dans ${roomId}`);
    
    if (!rooms[roomId]) return;
    
    const opponent = Object.values(room.players).find(p => p.playerId !== playerId);
    if (!opponent) return;
    
    const opponentScore = 2500;
    const inactiveScore = 0;
    
    console.log(`🏆 ${opponent.playerName} GAGNE par inactivité de ${player.playerName}`);
    console.log(`   Score gagnant: ${opponentScore} pts (bonus AFK)`);
    
    const result = {
      winnerId: opponent.playerId,
      winnerName: opponent.playerName,
      winnerScore: opponentScore,
      loserId: playerId,
      loserName: player.playerName,
      loserScore: inactiveScore,
      reason: 'inactivity'
    };
    
    room.status = 'finished';
    
    const opponentConnected = io.sockets.sockets.has(opponent.socketId);
    const inactiveConnected = io.sockets.sockets.has(player.socketId);
    
    if (opponentConnected) {
      io.to(opponent.socketId).emit('game_over', result);
      console.log(`✅ game_over inactivité envoyé au gagnant`);
    } else {
      finishedGames[opponent.playerId] = { result, timestamp: Date.now() };
      console.log(`💾 Résultat inactivité sauvegardé pour gagnant (déco)`);
    }
    
    if (inactiveConnected) {
      io.to(player.socketId).emit('game_over', result);
      console.log(`✅ game_over inactivité envoyé au perdant`);
    } else {
      finishedGames[playerId] = { result, timestamp: Date.now() };
      console.log(`💾 Résultat inactivité sauvegardé pour perdant (déco)`);
    }
    
    Object.values(room.players).forEach(p => {
      if (p.inactivityTimer) clearTimeout(p.inactivityTimer);
    });
    
    delete rooms[roomId];
    console.log(`🏁 Room ${roomId} supprimée (inactivité)`);
    
  }, INACTIVITY_TIMEOUT);
  
  console.log(`⏱️ Timer inactivité démarré pour ${player.playerName}`);
}

function resetPlayerInactivityTimer(roomId, playerId) {
  const room = rooms[roomId];
  if (!room) return;
  
  const player = room.players[playerId];
  if (!player) return;
  
  player.lastMoveTime = Date.now();
  
  if (player.inactivityTimer) {
    clearTimeout(player.inactivityTimer);
  }
  
  setupPlayerInactivityTimer(roomId, playerId);
  
  console.log(`⏱️ Timer reset pour ${player.playerName}`);
}

function tryMatchmaking(socket, playerId, playerName, gameMode, difficulty) {
  const queue = queues[gameMode][difficulty];
  
  console.log(`🔍 ${playerName} cherche: ${gameMode}/${difficulty} (${queue.length} en attente)`);
  
  if (queue.length > 0) {
    const opponent = queue.shift();
    
    // ✅✅✅ VÉRIFIER QUE LES 2 SOCKETS SONT CONNECTÉS
    if (!socket.connected || !io.sockets.sockets.has(opponent.socketId)) {
      console.log(`⚠️ Socket déconnecté - Match annulé`);
      
      // ✅ Remettre en queue si connecté
      if (socket.connected) queue.unshift({ playerId, playerName, socketId: socket.id, timestamp: Date.now() });
      if (io.sockets.sockets.has(opponent.socketId)) queue.unshift(opponent);
      
      return false;
    }
    
    const roomId = generateRoomId();
    const puzzle = generateSudokuPuzzle(difficulty);
    const solution = getSolution();
    
    const frozenInitialPuzzle = JSON.parse(JSON.stringify(puzzle));
    
    const isTimeAttack = gameMode.startsWith('timeAttack');
    const timeLimit = isTimeAttack ? TIME_ATTACK_DURATIONS[gameMode] : null;

    rooms[roomId] = {
      roomId,
      gameMode,
      difficulty,
      initialPuzzle: frozenInitialPuzzle,
      players: {
        [playerId]: {
          playerId, playerName,
          socketId: socket.id,
          grid: JSON.parse(JSON.stringify(puzzle)),
          solution: JSON.parse(JSON.stringify(solution)),
          correctMoves: 0, errors: 0, combo: 0, energy: 0,
          progress: calculateProgress(puzzle), speed: 0, 
          lastMoveTime: Date.now(),
          inactivityTimer: null,
          completedEarly: false
        },
        [opponent.playerId]: {
          playerId: opponent.playerId,
          playerName: opponent.playerName,
          socketId: opponent.socketId,
          grid: JSON.parse(JSON.stringify(puzzle)),
          solution: JSON.parse(JSON.stringify(solution)),
          correctMoves: 0, errors: 0, combo: 0, energy: 0,
          progress: calculateProgress(puzzle), speed: 0, 
          lastMoveTime: Date.now(),
          inactivityTimer: null,
          completedEarly: false
        }
      },
      status: 'playing',
      startTime: Date.now(),
      isTimeAttack,
      timeLimit,
      endTime: isTimeAttack ? (Date.now() + timeLimit) : null
    };
    
    setupPlayerInactivityTimer(roomId, playerId);
    setupPlayerInactivityTimer(roomId, opponent.playerId);
    
    if (isTimeAttack) {
      setTimeout(() => {
        const room = rooms[roomId];
        if (!room || room.status === 'finished') return;
        
        console.log(`⏱️ TIME ATTACK TERMINÉ - ${roomId}`);
        
        room.status = 'finished';
        
        const players = Object.values(room.players);
        const [p1, p2] = players;
        
        const score1 = calculateTimeAttackScore(p1);
        const score2 = calculateTimeAttackScore(p2);
        
        const winner = score1 > score2 ? p1 : p2;
        const loser = score1 > score2 ? p2 : p1;
        const winnerScore = Math.max(score1, score2);
        const loserScore = Math.min(score1, score2);
        
        console.log(`🏆 TIME ATTACK: ${winner.playerName} (${winnerScore}) vs ${loser.playerName} (${loserScore})`);
        
        const result = {
          winnerId: winner.playerId,
          winnerName: winner.playerName,
          winnerScore,
          loserId: loser.playerId,
          loserName: loser.playerName,
          loserScore,
          reason: 'time_up'
        };
        
        const winnerConnected = io.sockets.sockets.has(winner.socketId);
        const loserConnected = io.sockets.sockets.has(loser.socketId);
        
        if (winnerConnected) {
          io.to(winner.socketId).emit('game_over', result);
          console.log(`✅ game_over time_up envoyé au gagnant`);
        } else {
          finishedGames[winner.playerId] = { result, timestamp: Date.now() };
          console.log(`💾 Résultat time_up sauvegardé pour gagnant (déco)`);
        }
        
        if (loserConnected) {
          io.to(loser.socketId).emit('game_over', result);
          console.log(`✅ game_over time_up envoyé au perdant`);
        } else {
          finishedGames[loser.playerId] = { result, timestamp: Date.now() };
          console.log(`💾 Résultat time_up sauvegardé pour perdant (déco)`);
        }
        
        Object.values(room.players).forEach(p => {
          if (p.inactivityTimer) clearTimeout(p.inactivityTimer);
        });
        
        delete rooms[roomId];
      }, timeLimit);
    }
    
    console.log(`🎮 Match ${gameMode}/${difficulty}: ${playerName} vs ${opponent.playerName}`);
    
    io.to(socket.id).emit('matchFound', {
      roomId, 
      opponentName: opponent.playerName, 
      puzzle, 
      solution,
      gameMode,
      difficulty
    });
    
    io.to(opponent.socketId).emit('matchFound', {
      roomId, 
      opponentName: playerName, 
      puzzle, 
      solution,
      gameMode,
      difficulty
    });
    
    return true;
  }
  
  return false;
}

// ========== SOCKET.IO EVENTS ==========

io.on('connection', (socket) => {
  console.log('🔌 Client connecté:', socket.id);
  
  socket.emit('connection_established', { 
    socketId: socket.id,
    timestamp: Date.now(),
    serverReady: isServerReady  // ✅ AJOUTÉ
  });
  
  socket.on('player_connected', (data) => {
    const { playerId, playerName } = data;
    
    console.log(`📝 Enregistrement: ${playerName} (${playerId})`);
    
    connectedSockets[playerId] = socket.id;
    
    // ... RESTE DU CODE INCHANGÉ (reconnexion, etc.)
    
    if (finishedGames[playerId]) {
      const { result, timestamp } = finishedGames[playerId];
      
      console.log(`🎮 PARTIE TERMINÉE DÉTECTÉE pour ${playerName}`);
      console.log(`   Résultat: ${result.reason}`);
      console.log(`   Winner: ${result.winnerName} | Loser: ${result.loserName}`);
      
      socket.emit('game_over', result);
      delete finishedGames[playerId];
      socket.emit('connection_confirmed', { success: true, playerId });
      return;
    }
    
    if (disconnectedPlayers[playerId]) {
      const { roomId, timeout } = disconnectedPlayers[playerId];
      const room = rooms[roomId];
      
      if (room && room.players[playerId]) {
        clearTimeout(timeout);
        delete disconnectedPlayers[playerId];
        
        room.players[playerId].socketId = socket.id;
        
        setupPlayerInactivityTimer(roomId, playerId);
        const opponent = Object.values(room.players).find(p => p.playerId !== playerId);
        if (opponent) {
          setupPlayerInactivityTimer(roomId, opponent.playerId);
        }
        
        console.log(`✅ ${playerName} RECONNECTÉ à ${roomId}!`);
        
        const player = room.players[playerId];
        
        socket.emit('reconnection_dialog', {
          roomId,
          gameMode: room.gameMode,
          difficulty: room.difficulty,
          opponentName: opponent?.playerName || 'Adversaire',
          puzzle: player.grid,
          initialPuzzle: room.initialPuzzle,
          solution: player.solution,
          myProgress: player.progress,
          opponentProgress: opponent?.progress || 0,
          myStats: {
            correctMoves: player.correctMoves,
            errors: player.errors,
            combo: player.combo,
            energy: player.energy,
            speed: player.speed
          },
          elapsedSeconds: Math.floor((Date.now() - room.startTime) / 1000)
        });
        
        const opponentSocketId = getOpponentSocketId(roomId, playerId);
        if (opponentSocketId) {
          io.to(opponentSocketId).emit('opponent_reconnected', { playerName });
        }
        
        return;
      }
    }
    
    console.log(`✅ Joueur enregistré: ${playerName}`);
    socket.emit('connection_confirmed', { success: true, playerId });
  });
  
  socket.on('joinQueue', (data) => {
    const { playerId, playerName, gameMode, difficulty = 'medium' } = data;
    
    // ✅✅✅ VÉRIFICATIONS FLY.IO
    if (!socket.connected) {
      console.log(`⚠️ Socket ${socket.id} pas connecté - Rejet joinQueue`);
      socket.emit('error', { message: 'Socket non connecté, réessayez' });
      return;
    }
    
    if (!connectedSockets[playerId]) {
      console.log(`⚠️ ${playerName} non enregistré - Attente 2s...`);
      
      setTimeout(() => {
        if (connectedSockets[playerId] && socket.connected) {
          console.log(`✅ ${playerName} enregistré après délai - Retry join`);
          socket.emit('retry_join', { playerId, playerName, gameMode, difficulty });
        } else {
          console.log(`❌ ${playerName} toujours non enregistré après 2s`);
          socket.emit('error', { message: 'Enregistrement échoué, reconnectez-vous' });
        }
      }, 2000);
      return;
    }
    
    const validDifficulties = ['easy', 'medium', 'hard', 'expert'];
    const validModes = ['classic', 'powerup', 'timeAttackClassic', 'timeAttackPowerup'];
    
    if (!validModes.includes(gameMode)) {
      console.log(`⚠️ Mode invalide: ${gameMode}`);
      return;
    }
    
    const safeDifficulty = validDifficulties.includes(difficulty) ? difficulty : 'medium';
    
    console.log(`🔍 ${playerName} recherche: ${gameMode}/${safeDifficulty}`);
    
    // ✅ Retirer de toutes les queues
    for (const mode in queues) {
      for (const diff in queues[mode]) {
        const index = queues[mode][diff].findIndex(p => p.playerId === playerId);
        if (index !== -1) {
          console.log(`⚠️ Déjà en queue ${mode}/${diff} - Retrait`);
          queues[mode][diff].splice(index, 1);
        }
      }
    }
    
    const matched = tryMatchmaking(socket, playerId, playerName, gameMode, safeDifficulty);
    
    if (!matched) {
      queues[gameMode][safeDifficulty].push({ 
        playerId, 
        playerName, 
        socketId: socket.id,
        timestamp: Date.now()
      });
      
      socket.emit('waiting');
      console.log(`⏳ ${playerName} en attente (${gameMode}/${safeDifficulty})`);
    }
  });
  
  // ... RESTE DU CODE INCHANGÉ (cell_played, trigger_power, etc.)
  
  // [COPIER TOUT LE RESTE DE TON CODE ICI]
  // (leaveQueue, updateProgress, cell_played, trigger_power, heartbeat, 
  //  gameEnd, playerAbandoned, disconnect)
});

// ========== ROUTES API (INCHANGÉES) ==========

app.get('/', (req, res) => {
  res.json({
    status: 'alive',
    message: 'Sudoku Server v14 - FIX FLY.IO',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    serverReady: isServerReady
  });
});

// [COPIER /health et /stats INCHANGÉS]

// ========== START SERVER ==========

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur v14 - FIX FLY.IO sur port ${PORT}`);
  console.log(`🌐 Health: http://localhost:${PORT}/health`);
  console.log(`📊 Stats: http://localhost:${PORT}/stats`);
  
  // ✅✅✅ MARQUER SERVEUR PRÊT APRÈS 3s
  setTimeout(() => {
    isServerReady = true;
    console.log('✅ Serveur prêt à accepter connexions');
  }, 3000);
});
