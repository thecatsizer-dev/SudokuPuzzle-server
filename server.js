// server.js - BACKEND SOCKET.IO PRODUCTION READY v14 - FIX FLY.IO COMPLET
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
  connectTimeout: 10000,        // ✅ RÉDUIT 45s → 10s
  upgradeTimeout: 10000,        // ✅ RÉDUIT 30s → 10s
  serveClient: false,
  perMessageDeflate: false      // ✅ AJOUTÉ pour stabilité
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

// ✅ FLAG SERVEUR PRÊT (FLY.IO COLD START)
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

// ========== HELPER FUNCTIONS ==========

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

// ========== LIGNE 267 - REMPLACER tryMatchmaking() ==========

function tryMatchmaking(socket, playerId, playerName, gameMode, difficulty) {
  const queue = queues[gameMode][difficulty];
  
  console.log(`🔍 ${playerName} cherche: ${gameMode}/${difficulty} (${queue.length} en attente)`);
  
  if (queue.length > 0) {
    const opponent = queue.shift();
    
    // ✅✅✅ FIX: Récupérer les sockets ACTUELS depuis connectedSockets
    const myCurrentSocketId = connectedSockets[playerId];
    const opponentCurrentSocketId = connectedSockets[opponent.playerId];
    
    // ✅ Vérifier que les 2 joueurs ont des sockets valides
    if (!myCurrentSocketId || !io.sockets.sockets.has(myCurrentSocketId)) {
      console.log(`⚠️ ${playerName} - Socket invalide`);
      if (opponentCurrentSocketId && io.sockets.sockets.has(opponentCurrentSocketId)) {
        queue.unshift(opponent); // Remettre l'adversaire en queue
      }
      return false;
    }
    
    if (!opponentCurrentSocketId || !io.sockets.sockets.has(opponentCurrentSocketId)) {
      console.log(`⚠️ ${opponent.playerName} - Socket invalide`);
      queue.unshift({ playerId, playerName, socketId: myCurrentSocketId, timestamp: Date.now() });
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
          socketId: myCurrentSocketId, // ✅ Socket actuel
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
          socketId: opponentCurrentSocketId, // ✅ Socket actuel
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
    console.log(`   Sockets: ${myCurrentSocketId} vs ${opponentCurrentSocketId}`);
    
    // ✅ Envoi aux sockets ACTUELS
    io.to(myCurrentSocketId).emit('matchFound', {
      roomId, 
      opponentName: opponent.playerName, 
      puzzle, 
      solution,
      gameMode,
      difficulty
    });
    
    io.to(opponentCurrentSocketId).emit('matchFound', {
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
  
  // ✅✅✅ NETTOYER LES ANCIENS game_over DE PLUS DE 2 MINUTES
  if (finishedGames[playerId]) {
    const age = Date.now() - finishedGames[playerId].timestamp;
    
    if (age > 120000) { // 2 minutes
      console.log(`🧹 Ancien game_over supprimé (${Math.round(age/1000)}s)`);
      delete finishedGames[playerId];
    } else {
      const { result } = finishedGames[playerId];
      
      console.log(`🎮 PARTIE TERMINÉE RÉCENTE pour ${playerName}`);
      console.log(`   Résultat: ${result.reason}`);
      console.log(`   Winner: ${result.winnerName} | Loser: ${result.loserName}`);
      
      socket.emit('game_over', result);
      delete finishedGames[playerId];
      socket.emit('connection_confirmed', { success: true, playerId });
      return;
    }
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
  
// ========== LIGNE 583 - HANDLER joinQueue - AJOUT LOGS ==========

socket.on('joinQueue', (data) => {
  const { playerId, playerName, gameMode, difficulty = 'medium' } = data;
  
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
  
  // ✅✅✅ LOG CRITIQUE - Socket actuel vs socket en queue
  console.log(`🔍 ${playerName} joinQueue:`);
  console.log(`   Socket actuel: ${socket.id}`);
  console.log(`   Socket enregistré: ${connectedSockets[playerId]}`);
  
  const validDifficulties = ['easy', 'medium', 'hard', 'expert'];
  const validModes = ['classic', 'powerup', 'timeAttackClassic', 'timeAttackPowerup'];
  
  if (!validModes.includes(gameMode)) {
    console.log(`⚠️ Mode invalide: ${gameMode}`);
    return;
  }
  
  const safeDifficulty = validDifficulties.includes(difficulty) ? difficulty : 'medium';
  
  console.log(`🔍 ${playerName} recherche: ${gameMode}/${safeDifficulty}`);
  
  // Nettoyer anciennes queues
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
    // ✅ Utiliser le socket ACTUEL depuis connectedSockets
    queues[gameMode][safeDifficulty].push({ 
      playerId, 
      playerName, 
      socketId: connectedSockets[playerId], // ✅ FIX ICI
      timestamp: Date.now()
    });
    
    socket.emit('waiting');
    console.log(`⏳ ${playerName} en attente (${gameMode}/${safeDifficulty})`);
    console.log(`   Socket en queue: ${connectedSockets[playerId]}`);
  }
});
  
  socket.on('leaveQueue', () => {
    for (const mode in queues) {
      for (const difficulty in queues[mode]) {
        const index = queues[mode][difficulty].findIndex(p => p.socketId === socket.id);
        if (index !== -1) {
          const player = queues[mode][difficulty].splice(index, 1)[0];
          console.log(`🚪 ${player.playerName} quitte queue ${mode}/${difficulty}`);
        }
      }
    }
  });
  
  socket.on('updateProgress', (data) => {
    const { roomId, playerId, progress } = data;
    
    const room = rooms[roomId];
    if (!room) return;
    
    const player = room.players[playerId];
    if (!player) return;
    
    console.log(`⚠️ updateProgress DEPRECATED - Utilisez cell_played`);
  });
  
  socket.on('cell_played', (data) => {
    const { roomId, playerId, row, col, value } = data;
    
    const room = rooms[roomId];
    if (!room) return;
    
    const player = room.players[playerId];
    if (!player) return;
    
    if (value < 1 || value > 9) {
      console.log(`⚠️ Valeur invalide: ${value}`);
      return;
    }
    
    const initialGrid = room.initialPuzzle;
    if (initialGrid[row][col] !== 0) {
      console.log(`⚠️ Cellule fixe: [${row}][${col}]`);
      return;
    }
    
    const isCorrect = (value === player.solution[row][col]);
    
    player.grid[row][col] = value;
    
    if (isCorrect) {
      player.correctMoves++;
      player.combo++;
      
      if ((room.gameMode === 'powerup' || room.gameMode === 'timeAttackPowerup') && 
          player.combo > 0 && player.combo % 5 === 0) {
        player.energy = Math.floor(player.combo / 5);
        console.log(`⚡ ${player.playerName} ÉNERGIE +1 → Total: ${player.energy}`);
      }
    } else {
      player.errors++;
      player.combo = 0;
    }
    
    player.progress = calculateProgress(player.grid);
    
    console.log(`🎯 ${player.playerName} [${row}][${col}]=${value} → ${isCorrect ? '✅' : '❌'} | ${player.progress}/81`);
    
    resetPlayerInactivityTimer(roomId, playerId);
    
    const opponentSocketId = getOpponentSocketId(roomId, playerId);
    if (opponentSocketId) {
      io.to(opponentSocketId).emit('opponentProgress', {
        progress: player.progress,
        correctMoves: player.correctMoves,
        errors: player.errors,
        combo: player.combo,
        speed: Math.round(player.speed * 10) / 10,
        lastAction: isCorrect ? 'correct' : 'error'
      });
    }
    
    if (player.progress >= 81) {
      if (room.isTimeAttack) {
        console.log(`🎯 ${player.playerName} GRILLE TERMINÉE (Time Attack) - En attente timer`);
        
        player.completedEarly = true;
        
        io.to(player.socketId).emit('grid_completed', {
          completionBonus: 500,
          waitingForTimer: true
        });
        
        return;
      }
      
      room.status = 'finished';
      
      const opponentId = Object.keys(room.players).find(id => id !== playerId);
      const opponent = room.players[opponentId];
      
      const elapsed = (Date.now() - room.startTime) / 1000;
      const winnerScore = calculateScore(player, elapsed);
      const loserScore = calculateScore(opponent, elapsed);
      
      console.log(`🏆 ${player.playerName} GAGNE! ${winnerScore}pts vs ${loserScore}pts`);
      
      const result = {
        winnerId: playerId,
        winnerName: player.playerName,
        winnerScore,
        loserId: opponentId,
        loserName: opponent.playerName,
        loserScore,
        reason: 'completed'
      };
      
      const winnerConnected = io.sockets.sockets.has(player.socketId);
      const loserConnected = io.sockets.sockets.has(opponent.socketId);
      
      if (winnerConnected) {
        io.to(player.socketId).emit('game_over', result);
        console.log(`✅ game_over envoyé au gagnant`);
      } else {
        finishedGames[playerId] = { result, timestamp: Date.now() };
        console.log(`💾 Résultat sauvegardé pour gagnant (déco)`);
      }
      
      if (loserConnected) {
        io.to(opponent.socketId).emit('game_over', result);
        console.log(`✅ game_over envoyé au perdant`);
      } else {
        finishedGames[opponentId] = { result, timestamp: Date.now() };
        console.log(`💾 Résultat sauvegardé pour perdant (déco)`);
      }
      
      Object.values(room.players).forEach(p => {
        if (p.inactivityTimer) clearTimeout(p.inactivityTimer);
      });
      
      setTimeout(() => delete rooms[roomId], 5000);
    }
  });
  
  socket.on('trigger_power', (data) => {
  const { roomId, playerId } = data;
  
  const room = rooms[roomId];
  
  if (!room || (room.gameMode !== 'powerup' && room.gameMode !== 'timeAttackPowerup')) {
    console.log(`⚠️ Power-up impossible - Mode: ${room?.gameMode || 'unknown'}`);
    return;
  }
  
  const player = room.players[playerId];
  if (!player || player.energy < 1) {
    console.log(`⚠️ Énergie insuffisante - ${player?.playerName || 'unknown'}: ${player?.energy || 0}`);
    return;
  }
  
  player.energy--;
  
  resetPlayerInactivityTimer(roomId, playerId);
  
 const isTimeAttack = room.gameMode.startsWith('timeAttack');

let powers = [
  { type: 'fog', duration: 10000 },      // ✅ 10s
  { type: 'stun', duration: 5000 },      // ✅ 5s
  { type: 'flash', duration: 3000 },     // ✅ 3s
  { type: 'shake', duration: 15000 },    // ✅ 15s
  { type: 'cell_eraser', duration: 1000 } // ✅ Tous modes powerup
];

// ✅ TIME DRAIN uniquement en Time Attack
if (isTimeAttack) {
  powers.push({ type: 'time_drain', duration: 1500 });
}
  
 const randomPower = powers[Math.floor(Math.random() * powers.length)];
const opponentSocketId = getOpponentSocketId(roomId, playerId);

// ⏱️ TIME DRAIN - Voler 15 secondes (Time Attack uniquement)
if (randomPower.type === 'time_drain' && room.isTimeAttack) {
  const stolenSeconds = 15000; // 15s
  
  room.endTime = Math.max(Date.now(), room.endTime - stolenSeconds);
  
  console.log(`⏱️ ${player.playerName} VOLE 15s à l'adversaire`);
  
  if (opponentSocketId) {
    io.to(opponentSocketId).emit('powerup_triggered', {
      type: 'time_drain',
      duration: randomPower.duration
    });
  }
  
  return; // ✅ Fin du handler
}

// 🗑️ CELL ERASER - Effacer 1-2 cellules
if (randomPower.type === 'cell_eraser') {
  const opponentId = Object.keys(room.players).find(id => id !== playerId);
  const opponent = room.players[opponentId];
  
  if (!opponent) return;
  
  // 🎯 Trouver cellules non-vides (fixes ou jouées)
  const filledCells = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (opponent.grid[r][c] !== 0) {
        filledCells.push({ row: r, col: c });
      }
    }
  }
  
  if (filledCells.length === 0) {
    console.log(`⚠️ Aucune cellule à effacer`);
    return;
  }
  
  // 🎲 Effacer 1 ou 2 cellules aléatoires
  const toErase = Math.min(2, filledCells.length);
  const erasedCells = [];
  
  for (let i = 0; i < toErase; i++) {
    const randomIndex = Math.floor(Math.random() * filledCells.length);
    const cell = filledCells.splice(randomIndex, 1)[0];
    
    opponent.grid[cell.row][cell.col] = 0;
    erasedCells.push(cell);
  }
  
  // ♻️ Recalculer progress
  opponent.progress = calculateProgress(opponent.grid);
  opponent.correctMoves = Math.max(0, opponent.correctMoves - toErase);
  
  console.log(`🗑️ ${player.playerName} EFFACE ${toErase} cellule(s) de ${opponent.playerName}`);
  
  // 📤 Envoyer à la victime
  if (opponentSocketId) {
    io.to(opponentSocketId).emit('powerup_triggered', {
      type: 'cell_eraser',
      duration: randomPower.duration
    });
    
    io.to(opponentSocketId).emit('cells_erased', {
      erasedCells: erasedCells,
      newGrid: opponent.grid,
      newProgress: opponent.progress
    });
  }
  
  // 📤 Update attaquant (progress baisse)
  io.to(player.socketId).emit('opponentProgress', {
    progress: opponent.progress,
    correctMoves: opponent.correctMoves,
    errors: opponent.errors,
    combo: opponent.combo
  });
  
  return; // ✅ Fin du handler
}

// ✅ POWER-UPS NORMAUX (fog/stun/flash/shake)
const targetSelf = Math.random() < 0.40;

if (targetSelf) {
  console.log(`⚡ ${player.playerName} → ${randomPower.type} SUR LUI`);
  socket.emit('powerup_triggered', {
    type: randomPower.type,
    duration: randomPower.duration
  });
} else {
  console.log(`⚡ ${player.playerName} → ${randomPower.type} SUR ADVERSAIRE`);
  if (opponentSocketId) {
    io.to(opponentSocketId).emit('powerup_triggered', {
      type: randomPower.type,
      duration: randomPower.duration
    });
  }
}
});

  socket.on('heartbeat', (data) => {
    const { roomId, playerId } = data;
    
    const room = rooms[roomId];
    if (!room) return;
    
    const player = room.players[playerId];
    if (!player) return;
    
    resetPlayerInactivityTimer(roomId, playerId);
  });
  
  socket.on('gameEnd', (data) => {
    const { roomId, playerId, score, timeInSeconds } = data;
    console.log(`🏁 ${playerId}: ${score}pts en ${timeInSeconds}s`);
  });

  socket.on('playerAbandoned', (data) => {
    const { roomId, playerId } = data;
    
    const room = rooms[roomId];
    if (!room) return;
    
    const abandoned = room.players[playerId];
    if (!abandoned) return;
    
    console.log(`🚪 ${abandoned.playerName} ABANDONNE`);
    
    const opponentId = Object.keys(room.players).find(id => id !== playerId);
    const opponent = room.players[opponentId];
    
    if (opponent) {
      const winnerScore = calculateFinalScore(room, opponent);
      const loserScore = 0;
      
      const result = {
        winnerId: opponentId,
        winnerName: opponent.playerName,
        winnerScore,
        loserId: playerId,
        loserName: abandoned.playerName,
        loserScore,
        reason: 'opponent_abandoned'
      };
      
      const opponentConnected = io.sockets.sockets.has(opponent.socketId);
      const abandonedConnected = io.sockets.sockets.has(abandoned.socketId);
      
      if (opponentConnected) {
        io.to(opponent.socketId).emit('game_over', result);
        console.log(`✅ game_over abandon envoyé au gagnant`);
      } else {
        finishedGames[opponentId] = { result, timestamp: Date.now() };
        console.log(`💾 Résultat abandon sauvegardé pour gagnant (déco)`);
      }
      
      if (abandonedConnected) {
        io.to(abandoned.socketId).emit('game_over', result);
        console.log(`✅ game_over abandon envoyé au perdant`);
      } else {
        finishedGames[playerId] = { result, timestamp: Date.now() };
        console.log(`💾 Résultat abandon sauvegardé pour perdant (déco)`);
      }
      
      console.log(`   Winner: ${winnerScore} pts | Loser: ${loserScore} pts`);
    }
    
    Object.values(room.players).forEach(p => {
      if (p.inactivityTimer) clearTimeout(p.inactivityTimer);
    });
    
    if (disconnectedPlayers[playerId]) {
      clearTimeout(disconnectedPlayers[playerId].timeout);
      delete disconnectedPlayers[playerId];
    }
    
    delete rooms[roomId];
  });

  socket.on('disconnect', () => {
    console.log('🔌 Déconnexion:', socket.id);
    
    for (const mode in queues) {
      for (const difficulty in queues[mode]) {
        const index = queues[mode][difficulty].findIndex(p => p.socketId === socket.id);
        if (index !== -1) {
          const player = queues[mode][difficulty].splice(index, 1)[0];
          console.log(`🚪 ${player.playerName} retiré (déco)`);
        }
      }
    }
    
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const disconnected = Object.values(room.players).find(p => p.socketId === socket.id);
      
      if (disconnected) {
        console.log(`⚠️ ${disconnected.playerName} déco - ATTENTE 60s`);
        
        disconnectedPlayers[disconnected.playerId] = {
          roomId,
          timestamp: Date.now(),
          timeout: setTimeout(() => {
            console.log(`⏰ ${disconnected.playerName} absent après 60s`);
            
            const opponentId = Object.keys(room.players).find(id => id !== disconnected.playerId);
            const opponent = room.players[opponentId];
            
            if (opponent) {
              const winnerScore = calculateFinalScore(room, opponent);
              const loserScore = 0;
              
              const result = {
                winnerId: opponentId,
                winnerName: opponent.playerName,
                winnerScore,
                loserId: disconnected.playerId,
                loserName: disconnected.playerName,
                loserScore,
                reason: 'opponent_abandoned'
              };
              
              const opponentConnected = io.sockets.sockets.has(opponent.socketId);
              
              if (opponentConnected) {
                io.to(opponent.socketId).emit('game_over', result);
                console.log(`✅ game_over timeout envoyé à ${opponent.playerName}`);
              } else {
                finishedGames[opponentId] = { result, timestamp: Date.now() };
                console.log(`💾 Résultat timeout sauvegardé pour adversaire (déco)`);
              }
              
              finishedGames[disconnected.playerId] = { result, timestamp: Date.now() };
              console.log(`💾 Résultat timeout sauvegardé pour ${disconnected.playerName}`);
              console.log(`   Winner: ${winnerScore} pts | Loser: ${loserScore} pts`);
            }
            
            Object.values(room.players).forEach(p => {
              if (p.inactivityTimer) clearTimeout(p.inactivityTimer);
            });
            
            delete rooms[roomId];
            delete disconnectedPlayers[disconnected.playerId];
          }, RECONNECT_TIMEOUT)
        };
        
        const opponentId = Object.keys(room.players).find(id => id !== disconnected.playerId);
        const opponentSocketId = room.players[opponentId]?.socketId;
        
        if (opponentSocketId) {
          io.to(opponentSocketId).emit('opponent_disconnected_temp', {
            playerName: disconnected.playerName,
            waitTime: 60
          });
        }
        
        break;
      }
    }
    
    for (const playerId in connectedSockets) {
      if (connectedSockets[playerId] === socket.id) {
        delete connectedSockets[playerId];
        break;
      }
    }
  });
});

// ========== ROUTES API ==========

app.get('/', (req, res) => {
  res.json({
    status: 'alive',
    message: 'Sudoku Server v14 - FIX FLY.IO COMPLET',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    serverReady: isServerReady
  });
});

app.get('/health', (req, res) => {
  const memUsage = process.memoryUsage();
  
  let totalWaiting = 0;
  for (const mode in queues) {
    for (const difficulty in queues[mode]) {
      totalWaiting += queues[mode][difficulty].length;
    }
  }
  
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    rooms: Object.keys(rooms).length,
    queues: {
      classic: {
        easy: queues.classic.easy.length,
        medium: queues.classic.medium.length,
        hard: queues.classic.hard.length,
        expert: queues.classic.expert.length
      },
      powerup: {
        easy: queues.powerup.easy.length,
        medium: queues.powerup.medium.length,
        hard: queues.powerup.hard.length,
        expert: queues.powerup.expert.length
      },
      timeAttackClassic: {
        easy: queues.timeAttackClassic.easy.length,
        medium: queues.timeAttackClassic.medium.length,
        hard: queues.timeAttackClassic.hard.length,
        expert: queues.timeAttackClassic.expert.length
      },
      timeAttackPowerup: {
        easy: queues.timeAttackPowerup.easy.length,
        medium: queues.timeAttackPowerup.medium.length,
        hard: queues.timeAttackPowerup.hard.length,
        expert: queues.timeAttackPowerup.expert.length
      },
      total: totalWaiting
    },
    connectedPlayers: Object.keys(connectedSockets).length,
    disconnectedPlayers: Object.keys(disconnectedPlayers).length,
    finishedGames: Object.keys(finishedGames).length,
    memory: {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB'
    },
    serverReady: isServerReady
  });
});

app.get('/stats', (req, res) => {
  res.json({
    rooms: Object.keys(rooms).map(id => ({
      roomId: id,
      gameMode: rooms[id].gameMode,
      difficulty: rooms[id].difficulty,
      status: rooms[id].status,
      players: Object.keys(rooms[id].players).map(pid => ({
        name: rooms[id].players[pid].playerName,
        progress: rooms[id].players[pid].progress,
        combo: rooms[id].players[pid].combo,
        energy: rooms[id].players[pid].energy
      }))
    })),
    queues: {
      classic: {
        easy: queues.classic.easy.map(p => ({ name: p.playerName })),
        medium: queues.classic.medium.map(p => ({ name: p.playerName })),
        hard: queues.classic.hard.map(p => ({ name: p.playerName })),
        expert: queues.classic.expert.map(p => ({ name: p.playerName }))
      },
      powerup: {
        easy: queues.powerup.easy.map(p => ({ name: p.playerName })),
        medium: queues.powerup.medium.map(p => ({ name: p.playerName })),
        hard: queues.powerup.hard.map(p => ({ name: p.playerName })),
        expert: queues.powerup.expert.map(p => ({ name: p.playerName }))
      },
      timeAttackClassic: {
        easy: queues.timeAttackClassic.easy.map(p => ({ name: p.playerName })),
        medium: queues.timeAttackClassic.medium.map(p => ({ name: p.playerName })),
        hard: queues.timeAttackClassic.hard.map(p => ({ name: p.playerName })),
        expert: queues.timeAttackClassic.expert.map(p => ({ name: p.playerName }))
      },
      timeAttackPowerup: {
        easy: queues.timeAttackPowerup.easy.map(p => ({ name: p.playerName })),
        medium: queues.timeAttackPowerup.medium.map(p => ({ name: p.playerName })),
        hard: queues.timeAttackPowerup.hard.map(p => ({ name: p.playerName })),
        expert: queues.timeAttackPowerup.expert.map(p => ({ name: p.playerName }))
      }
    },
    disconnectedPlayers: Object.keys(disconnectedPlayers).length,
    finishedGames: Object.keys(finishedGames).length
  });
});

setInterval(() => {
  let totalWaiting = 0;
  for (const mode in queues) {
    for (const difficulty in queues[mode]) {
      totalWaiting += queues[mode][difficulty].length;
    }
  }
  
  console.log('📊 ========== STATS ==========');
  console.log(`   Rooms: ${Object.keys(rooms).length}`);
  console.log(`   Players Waiting: ${totalWaiting}`);
  console.log(`   Connected: ${Object.keys(connectedSockets).length}`);
  console.log(`   Disconnected: ${Object.keys(disconnectedPlayers).length}`);
  console.log(`   Finished Games Cache: ${Object.keys(finishedGames).length}`);
  console.log('==============================');
}, 300000);

const PORT = process.env.PORT || 3000;

// ✅✅✅ DÉMARRAGE SERVEUR AVEC WARM-UP FLY.IO
server.listen(PORT, () => {
  console.log(`🚀 Serveur v14 - FIX FLY.IO COMPLET sur port ${PORT}`);
  console.log(`🌐 Health: http://localhost:${PORT}/health`);
  console.log(`📊 Stats: http://localhost:${PORT}/stats`);
  
  // ✅ WARM-UP 3s avant d'accepter les matchs (Fly.io cold start)
  setTimeout(() => {
    isServerReady = true;
    console.log('✅✅✅ SERVEUR PRÊT - Acceptation des matchs activée');
  }, 3000);
});
