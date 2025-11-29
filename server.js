// server.js - BACKEND SOCKET.IO v16 - POOL SYSTEM CORRIGÉ
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

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
  connectTimeout: 10000,
  upgradeTimeout: 10000,
  serveClient: false,
  perMessageDeflate: false
});

app.use(cors());
app.use(express.json());

// ========== STRUCTURES DE DONNÉES ==========

const rooms = {};
const queues = {
  classic: { easy: [], medium: [], hard: [], expert: [] },
  powerup: { easy: [], medium: [], hard: [], expert: [] },
  timeAttackClassic: { easy: [], medium: [], hard: [], expert: [] },
  timeAttackPowerup: { easy: [], medium: [], hard: [], expert: [] }
};

const connectedSockets = {};
const disconnectedPlayers = {};
const finishedGames = {};

let isServerReady = false;

const INACTIVITY_TIMEOUT = 3 * 60 * 1000;
const RECONNECT_TIMEOUT = 60000;
const FINISHED_GAME_TTL = 5 * 60 * 1000;
const TIME_ATTACK_DURATIONS = {
  timeAttackClassic: 3 * 60 * 1000,
  timeAttackPowerup: 5 * 60 * 1000
};

// Cleanup automatique
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

function getBasePointsPerCell(difficulty) {
  const points = {
    easy: 15,
    medium: 30,
    hard: 40,
    expert: 50
  };
  return points[difficulty] || 30;
}

function getComboMultiplier(combo) {
  if (combo >= 15) return 3.0;
  if (combo >= 8) return 2.0;
  if (combo >= 3) return 1.5;
  return 1.0;
}

function getErrorPenalty(difficulty) {
  const penalties = {
    easy: 30,
    medium: 50,
    hard: 80,
    expert: 120
  };
  return penalties[difficulty] || 50;
}

function getErrorLimit(difficulty) {
  const limits = {
    easy: 5,
    medium: 3,
    hard: 3,
    expert: 2
  };
  return limits[difficulty] || 3;
}

// ✅✅✅ NOUVEAU - POOL INITIAL selon difficulté
function getInitialPool(difficulty) {
  const pools = {
    easy: 800,
    medium: 1500,
    hard: 2000,
    expert: 3000
  };
  return pools[difficulty] || 1500;
}

// ✅✅✅ NOUVEAU - DRAIN RATE selon difficulté
function getDrainRate(difficulty) {
  const rates = {
    easy: 1,
    medium: 2,
    hard: 3,
    expert: 4
  };
  return rates[difficulty] || 2;
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
    // ✅ MODE CLASSIC/POWERUP → Retourner currentScore (pool)
    return player.currentScore || 0;
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
    } else {
      finishedGames[opponent.playerId] = { result, timestamp: Date.now() };
    }
    
    if (inactiveConnected) {
      io.to(player.socketId).emit('game_over', result);
    } else {
      finishedGames[playerId] = { result, timestamp: Date.now() };
    }
    
    Object.values(room.players).forEach(p => {
      if (p.inactivityTimer) clearTimeout(p.inactivityTimer);
      if (p.timeAttackTimer) clearTimeout(p.timeAttackTimer);
    });
    
    // ✅ CLEANUP DRAIN INTERVAL
    if (room.drainInterval) {
      clearInterval(room.drainInterval);
    }
    
    delete rooms[roomId];
    console.log(`🏁 Room ${roomId} supprimée (inactivité)`);
    
  }, INACTIVITY_TIMEOUT);
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
}

function tryMatchmaking(socket, playerId, playerName, gameMode, difficulty) {
  const queue = queues[gameMode][difficulty];
  
  console.log(`🔍 ${playerName} cherche: ${gameMode}/${difficulty} (${queue.length} en attente)`);
  
  if (queue.length > 0) {
    const opponent = queue.shift();
    
    const myCurrentSocketId = connectedSockets[playerId];
    const opponentCurrentSocketId = connectedSockets[opponent.playerId];
    
    if (!myCurrentSocketId || !io.sockets.sockets.has(myCurrentSocketId)) {
      console.log(`⚠️ ${playerName} - Socket invalide`);
      if (opponentCurrentSocketId && io.sockets.sockets.has(opponentCurrentSocketId)) {
        queue.unshift(opponent);
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

    // ✅✅✅ POOL INITIAL pour classic/powerup uniquement
    const initialScore = isTimeAttack ? 0 : getInitialPool(difficulty);

    rooms[roomId] = {
      roomId,
      gameMode,
      difficulty,
      initialPuzzle: frozenInitialPuzzle,
      players: {
        [playerId]: {
          playerId, playerName,
          socketId: myCurrentSocketId,
          grid: JSON.parse(JSON.stringify(puzzle)),
          solution: JSON.parse(JSON.stringify(solution)),
          correctMoves: 0, 
          errors: 0, 
          combo: 0, 
          energy: 0,
          currentScore: initialScore, // ✅ POOL INITIAL
          progress: calculateProgress(puzzle), 
          speed: 0, 
          lastMoveTime: Date.now(),
          inactivityTimer: null,
          completedEarly: false,
          personalEndTime: isTimeAttack ? (Date.now() + timeLimit) : null,
          hasFinished: false,
          finalScore: 0,
          timeAttackTimer: null
        },
        [opponent.playerId]: {
          playerId: opponent.playerId,
          playerName: opponent.playerName,
          socketId: opponentCurrentSocketId,
          grid: JSON.parse(JSON.stringify(puzzle)),
          solution: JSON.parse(JSON.stringify(solution)),
          correctMoves: 0, 
          errors: 0, 
          combo: 0, 
          energy: 0,
          currentScore: initialScore, // ✅ POOL INITIAL
          progress: calculateProgress(puzzle), 
          speed: 0, 
          lastMoveTime: Date.now(),
          inactivityTimer: null,
          completedEarly: false,
          personalEndTime: isTimeAttack ? (Date.now() + timeLimit) : null,
          hasFinished: false,
          finalScore: 0,
          timeAttackTimer: null
        }
      },
      status: 'playing',
      startTime: Date.now(),
      isTimeAttack,
      timeLimit,
      drainInterval: null // ✅ NOUVEAU
    };
    
    setupPlayerInactivityTimer(roomId, playerId);
    setupPlayerInactivityTimer(roomId, opponent.playerId);
    
    if (isTimeAttack) {
      rooms[roomId].players[playerId].timeAttackTimer = setTimeout(() => {
        handlePlayerTimeExpired(roomId, playerId);
      }, timeLimit);
      
      rooms[roomId].players[opponent.playerId].timeAttackTimer = setTimeout(() => {
        handlePlayerTimeExpired(roomId, opponent.playerId);
      }, timeLimit);
      
      console.log(`⏱️ Timers TIME ATTACK créés (${timeLimit/1000}s)`);
    } else {
      // ✅✅✅ ACTIVER DRAIN POOL pour classic/powerup
      const drainRate = getDrainRate(difficulty);
      console.log(`💧 Activation drain pool ${difficulty} (${drainRate}pts/sec)`);
      
      rooms[roomId].drainInterval = setInterval(() => {
        if (!rooms[roomId] || rooms[roomId].status !== 'playing') {
          clearInterval(rooms[roomId].drainInterval);
          return;
        }
        
        Object.values(rooms[roomId].players).forEach(p => {
          if (!p.hasFinished) {
            p.currentScore = Math.max(0, p.currentScore - drainRate);
            
            // Envoyer update au client
            const playerSocket = io.sockets.sockets.get(p.socketId);
            if (playerSocket && playerSocket.connected) {
              playerSocket.emit('score_drained', {
                currentScore: p.currentScore,
                drainRate: drainRate
              });
            }
          }
        });
      }, 1000); // Chaque seconde
    }
    
    console.log(`🎮 Match ${gameMode}/${difficulty}: ${playerName} vs ${opponent.playerName}`);
    
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
    
    setTimeout(() => {
      if (rooms[roomId]) {
        io.to(myCurrentSocketId).emit('game_mode_sync', { gameMode });
        io.to(opponentCurrentSocketId).emit('game_mode_sync', { gameMode });
      }
    }, 500);
    
    return true;
  }
  
  return false;
}

function handlePlayerTimeExpired(roomId, playerId) {
  const room = rooms[roomId];
  
  if (!room || room.status === 'finished') {
    return;
  }
  
  const player = room.players[playerId];
  if (!player) return;
  
  console.log(`⏰ TIMER EXPIRÉ - ${player.playerName}`);
  
  player.hasFinished = true;
  player.finalScore = player.currentScore; // ✅ Utiliser currentScore
  
  const playerConnected = io.sockets.sockets.has(player.socketId);
  if (playerConnected) {
    io.to(player.socketId).emit('time_expired', {
      yourScore: player.finalScore,
      waitingForOpponent: true
    });
  }
  
  const opponentId = Object.keys(room.players).find(id => id !== playerId);
  const opponent = room.players[opponentId];
  
  if (opponent && opponent.hasFinished) {
    endTimeAttackGame(roomId);
  }
}

function endTimeAttackGame(roomId) {
  const room = rooms[roomId];
  if (!room || room.status === 'finished') return;
  
  room.status = 'finished';
  
  const players = Object.values(room.players);
  const [p1, p2] = players;
  
  const score1 = p1.finalScore || p1.currentScore;
  const score2 = p2.finalScore || p2.currentScore;
  
  const winner = score1 > score2 ? p1 : p2;
  const loser = score1 > score2 ? p2 : p1;
  const winnerScore = Math.max(score1, score2);
  const loserScore = Math.min(score1, score2);
  
  console.log(`🏆 TIME ATTACK TERMINÉ: ${winner.playerName} (${winnerScore}) vs ${loser.playerName} (${loserScore})`);
  
  const result = {
    winnerId: winner.playerId,
    winnerName: winner.playerName,
    winnerScore,
    loserId: loser.playerId,
    loserName: loser.playerName,
    loserScore,
    reason: 'time_attack_finished'
  };
  
  const winnerConnected = io.sockets.sockets.has(winner.socketId);
  const loserConnected = io.sockets.sockets.has(loser.socketId);
  
  if (winnerConnected) {
    io.to(winner.socketId).emit('game_over', result);
  } else {
    finishedGames[winner.playerId] = { result, timestamp: Date.now() };
  }
  
  if (loserConnected) {
    io.to(loser.socketId).emit('game_over', result);
  } else {
    finishedGames[loser.playerId] = { result, timestamp: Date.now() };
  }
  
  Object.values(room.players).forEach(p => {
    if (p.inactivityTimer) clearTimeout(p.inactivityTimer);
    if (p.timeAttackTimer) clearTimeout(p.timeAttackTimer);
  });
  
  // ✅ CLEANUP DRAIN INTERVAL
  if (room.drainInterval) {
    clearInterval(room.drainInterval);
  }
  
  delete rooms[roomId];
}

// ========== SOCKET.IO EVENTS ==========

io.on('connection', (socket) => {
  console.log('🔌 Client connecté:', socket.id);
  
  socket.emit('connection_established', { 
    socketId: socket.id,
    timestamp: Date.now(),
    serverReady: isServerReady
  });
  
  socket.on('player_connected', (data) => {
    const { playerId, playerName } = data;
    
    console.log(`📝 Enregistrement: ${playerName} (${playerId})`);
    
    connectedSockets[playerId] = socket.id;
    
    if (finishedGames[playerId]) {
      const age = Date.now() - finishedGames[playerId].timestamp;
      
      if (age > 120000) {
        delete finishedGames[playerId];
      } else {
        const { result } = finishedGames[playerId];
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
    
    socket.emit('connection_confirmed', { success: true, playerId });
  });
  
  socket.on('joinQueue', (data) => {
    const { playerId, playerName, gameMode, difficulty = 'medium' } = data;
    
    if (!socket.connected) {
      socket.emit('error', { message: 'Socket non connecté, réessayez' });
      return;
    }
    
    if (!connectedSockets[playerId]) {
      setTimeout(() => {
        if (connectedSockets[playerId] && socket.connected) {
          socket.emit('retry_join', { playerId, playerName, gameMode, difficulty });
        } else {
          socket.emit('error', { message: 'Enregistrement échoué, reconnectez-vous' });
        }
      }, 2000);
      return;
    }
    
    const validDifficulties = ['easy', 'medium', 'hard', 'expert'];
    const validModes = ['classic', 'powerup', 'timeAttackClassic', 'timeAttackPowerup'];
    
    if (!validModes.includes(gameMode)) {
      return;
    }
    
    const safeDifficulty = validDifficulties.includes(difficulty) ? difficulty : 'medium';
    
    for (const mode in queues) {
      for (const diff in queues[mode]) {
        const index = queues[mode][diff].findIndex(p => p.playerId === playerId);
        if (index !== -1) {
          queues[mode][diff].splice(index, 1);
        }
      }
    }
    
    const matched = tryMatchmaking(socket, playerId, playerName, gameMode, safeDifficulty);
    
    if (!matched) {
      queues[gameMode][safeDifficulty].push({ 
        playerId, 
        playerName, 
        socketId: connectedSockets[playerId],
        timestamp: Date.now()
      });
      
      socket.emit('waiting');
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
  // ========== HANDLER cell_played - POOL SYSTEM CORRIGÉ ==========
  
  socket.on('cell_played', (data) => {
    const { roomId, playerId, row, col, value } = data;
    
    const room = rooms[roomId];
    if (!room) return;
    
    const player = room.players[playerId];
    if (!player) return;
    
    if (player.hasFinished) {
      console.log(`⚠️ ${player.playerName} a fini - Action bloquée`);
      return;
    }
    
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
    
    // ✅✅✅ CALCUL POINTS AVEC MULTIPLICATEUR
    let pointsGained = 0;
    
    if (isCorrect) {
      player.correctMoves++;
      player.combo++;
      
      // ✅ CALCULER POINTS AVEC MULTIPLICATEUR
      const basePoints = getBasePointsPerCell(room.difficulty);
      const multiplier = getComboMultiplier(player.combo);
      pointsGained = Math.round(basePoints * multiplier);
      
      // ✅✅✅ MODE TIME ATTACK → AJOUTER | MODE CLASSIC/POWERUP → AJOUTER AU POOL
      player.currentScore = (player.currentScore || 0) + pointsGained;
      
      if (room.isTimeAttack) {
        console.log(`✅ ${player.playerName} [TIME ATTACK] Combo=${player.combo} x${multiplier} → +${pointsGained}pts (Total: ${player.currentScore})`);
      } else {
        console.log(`✅ ${player.playerName} [CLASSIC] Combo=${player.combo} x${multiplier} → +${pointsGained}pts (Pool: ${player.currentScore})`);
      }
      
      // ✅ ENERGY (modes powerup uniquement)
      if (room.gameMode === 'powerup' || room.gameMode === 'timeAttackPowerup') {
        if (player.combo > 0 && player.combo % 5 === 0) {
          player.energy++;
          console.log(`⚡ ${player.playerName} Combo=${player.combo} → Energy +1 (Total: ${player.energy})`);
        }
      }
    } else {
      player.errors++;
      player.combo = 0;
      
      // ✅ PÉNALITÉ (retire du pool ou du score selon mode)
      const penalty = getErrorPenalty(room.difficulty);
      player.currentScore = Math.max(0, (player.currentScore || 0) - penalty);
      
      if (room.isTimeAttack) {
        console.log(`❌ ${player.playerName} [TIME ATTACK] Erreur → Combo=0, -${penalty}pts (Total: ${player.currentScore})`);
      } else {
        console.log(`❌ ${player.playerName} [CLASSIC] Erreur → Combo=0, -${penalty}pts (Pool: ${player.currentScore})`);
      }
      
      // ✅ RESET ENERGY
      if (room.gameMode === 'powerup' || room.gameMode === 'timeAttackPowerup') {
        player.energy = 0;
      }
    }
    
    player.progress = calculateProgress(player.grid);
    
    resetPlayerInactivityTimer(roomId, playerId);
    
    // ✅ NOTIFIER ADVERSAIRE
    const opponentSocketId = getOpponentSocketId(roomId, playerId);
    if (opponentSocketId) {
      io.to(opponentSocketId).emit('opponentProgress', {
        progress: player.progress,
        correctMoves: player.correctMoves,
        errors: player.errors,
        combo: player.combo,
        energy: player.energy,
        speed: 0,
        lastAction: isCorrect ? 'correct' : 'error'
      });
    }
    
    // ✅✅✅ ENVOYER STATS COMPLÈTES AU JOUEUR
    io.to(player.socketId).emit('stats_update', {
      correctMoves: player.correctMoves,
      errors: player.errors,
      combo: player.combo,
      energy: player.energy,
      progress: player.progress,
      currentScore: player.currentScore,
      pointsGained: pointsGained,
      comboMultiplier: getComboMultiplier(player.combo)
    });
    
    // ✅ VÉRIFIER LIMITE ERREURS
    const errorLimit = getErrorLimit(room.difficulty);
    if (!isCorrect && player.errors >= errorLimit) {
      console.log(`🚨 ${player.playerName} LIMITE ERREURS: ${player.errors}/${errorLimit}`);
      
      room.status = 'finished';
      
      const opponentId = Object.keys(room.players).find(id => id !== playerId);
      const opponent = room.players[opponentId];
      
      const winnerScore = opponent.currentScore || calculateFinalScore(room, opponent);
      const loserScore = 0;
      
      console.log(`🏆 ${opponent.playerName} GAGNE par erreurs! ${winnerScore}pts vs ${loserScore}pts`);
      
      const result = {
        winnerId: opponentId,
        winnerName: opponent.playerName,
        winnerScore,
        loserId: playerId,
        loserName: player.playerName,
        loserScore,
        reason: 'too_many_errors'
      };
      
      const winnerConnected = io.sockets.sockets.has(opponent.socketId);
      const loserConnected = io.sockets.sockets.has(player.socketId);
      
      if (winnerConnected) {
        io.to(opponent.socketId).emit('game_over', result);
      } else {
        finishedGames[opponentId] = { result, timestamp: Date.now() };
      }
      
      if (loserConnected) {
        io.to(player.socketId).emit('game_over', result);
      } else {
        finishedGames[playerId] = { result, timestamp: Date.now() };
      }
      
      Object.values(room.players).forEach(p => {
        if (p.inactivityTimer) clearTimeout(p.inactivityTimer);
        if (p.timeAttackTimer) clearTimeout(p.timeAttackTimer);
      });
      
      // ✅ CLEANUP DRAIN INTERVAL
      if (room.drainInterval) {
        clearInterval(room.drainInterval);
      }
      
      setTimeout(() => delete rooms[roomId], 5000);
      return;
    }
    
    // ✅ VÉRIFIER GRILLE COMPLÈTE
    if (player.progress >= 81) {
      let isActuallyComplete = true;
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          if (player.grid[r][c] !== player.solution[r][c]) {
            isActuallyComplete = false;
            break;
          }
        }
        if (!isActuallyComplete) break;
      }

      if (!isActuallyComplete) {
        console.log(`⚠️ ${player.playerName} progress 81/81 mais grille incorrecte`);
        return;
      }

      if (room.isTimeAttack) {
        console.log(`🎯 ${player.playerName} GRILLE TERMINÉE (Time Attack)`);
        
        player.completedEarly = true;
        player.hasFinished = true;
        player.finalScore = player.currentScore + 500; // ✅ Bonus completion
        
        io.to(player.socketId).emit('grid_completed', {
          completionBonus: 500,
          waitingForTimer: true
        });
        
        const opponentId = Object.keys(room.players).find(id => id !== playerId);
        const opponent = room.players[opponentId];
        
        if (opponent && opponent.hasFinished) {
          endTimeAttackGame(roomId);
        }
        
        return;
      }
      
      // ✅ MODE CLASSIQUE - VICTOIRE IMMÉDIATE
      room.status = 'finished';
      
      const opponentId = Object.keys(room.players).find(id => id !== playerId);
      const opponent = room.players[opponentId];
      
      const winnerScore = player.currentScore;
      const loserScore = opponent.currentScore || 0;
      
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
      } else {
        finishedGames[playerId] = { result, timestamp: Date.now() };
      }
      
      if (loserConnected) {
        io.to(opponent.socketId).emit('game_over', result);
      } else {
        finishedGames[opponentId] = { result, timestamp: Date.now() };
      }
      
      Object.values(room.players).forEach(p => {
        if (p.inactivityTimer) clearTimeout(p.inactivityTimer);
        if (p.timeAttackTimer) clearTimeout(p.timeAttackTimer);
      });
      
      // ✅ CLEANUP DRAIN INTERVAL
      if (room.drainInterval) {
        clearInterval(room.drainInterval);
      }
      
      setTimeout(() => delete rooms[roomId], 5000);
    }
  });
  
  // ========== HANDLER trigger_power ==========
  
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
    
    // ✅✅✅ DÉCRÉMENTER ENERGY CÔTÉ SERVEUR
    player.energy--;
    console.log(`⚡ ${player.playerName} utilise power-up → Energy restante: ${player.energy}`);
    
    // ✅ RENVOYER LA NOUVELLE ENERGY AU CLIENT
    io.to(player.socketId).emit('stats_update', {
      correctMoves: player.correctMoves,
      errors: player.errors,
      combo: player.combo,
      energy: player.energy,
      progress: player.progress,
      currentScore: player.currentScore
    });
    
    resetPlayerInactivityTimer(roomId, playerId);
    
    const isTimeAttack = room.gameMode.startsWith('timeAttack');

    let powers = [
      { type: 'fog', duration: 10000 },
      { type: 'stun', duration: 5000 },
      { type: 'flash', duration: 3000 },
      { type: 'shake', duration: 15000 },
      { type: 'cell_eraser', duration: 1000 }
    ];

    if (isTimeAttack) {
      powers.push({ type: 'time_drain', duration: 1500 });
    }
    
    const randomPower = powers[Math.floor(Math.random() * powers.length)];
    const opponentSocketId = getOpponentSocketId(roomId, playerId);
    
    console.log(`🎲 Power-up choisi: ${randomPower.type} (durée: ${randomPower.duration}ms)`);

    // ⏱️ TIME DRAIN
    if (randomPower.type === 'time_drain' && room.isTimeAttack) {
      console.log(`⏱️ TIME DRAIN activé`);
      
      const stolenMs = 15000;
      
      const opponentId = Object.keys(room.players).find(id => id !== playerId);
      const opponent = room.players[opponentId];
      
      if (!opponent) return;
      
      const now = Date.now();
      
      if (opponent.timeAttackTimer) {
        clearTimeout(opponent.timeAttackTimer);
      }
      
      if (player.timeAttackTimer) {
        clearTimeout(player.timeAttackTimer);
      }
      
      if (opponent.personalEndTime) {
        opponent.personalEndTime = Math.max(now, opponent.personalEndTime - stolenMs);
      }
      
      if (player.personalEndTime) {
        player.personalEndTime = player.personalEndTime + stolenMs;
      }
      
      const opponentTimeRemaining = Math.max(0, opponent.personalEndTime - now);
      const playerTimeRemaining = Math.max(0, player.personalEndTime - now);
      
      if (opponentTimeRemaining > 0) {
        opponent.timeAttackTimer = setTimeout(() => {
          handlePlayerTimeExpired(roomId, opponentId);
        }, opponentTimeRemaining);
      } else {
        handlePlayerTimeExpired(roomId, opponentId);
      }
      
      if (playerTimeRemaining > 0) {
        player.timeAttackTimer = setTimeout(() => {
          handlePlayerTimeExpired(roomId, playerId);
        }, playerTimeRemaining);
      }
      
      console.log(`✅ Événement time_drain envoyé`);
      
      if (opponentSocketId) {
        io.to(opponentSocketId).emit('powerup_triggered', {
          type: 'time_drain',
          duration: randomPower.duration
        });
        
        io.to(opponentSocketId).emit('time_drained', {
          drainingPlayerId: playerId,
          newEndTime: opponent.personalEndTime,
          timeReduced: stolenMs,
          timeBoosted: 0
        });
      }

      io.to(player.socketId).emit('time_drained', {
        drainingPlayerId: playerId,
        newEndTime: player.personalEndTime,
        timeReduced: 0,
        timeBoosted: stolenMs
      });
      
      return;
    }

    // 🗑️ CELL ERASER
    if (randomPower.type === 'cell_eraser') {
      console.log(`🗑️ CELL ERASER activé`);
      
      const opponentId = Object.keys(room.players).find(id => id !== playerId);
      const opponent = room.players[opponentId];
      
      if (!opponent) return;
      
      const validatedCells = [];
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          const isInitialCell = room.initialPuzzle[r][c] !== 0;
          const isFilledByPlayer = opponent.grid[r][c] !== 0 && !isInitialCell;
          
          if (isFilledByPlayer) {
            validatedCells.push({ row: r, col: c });
          }
        }
      }
      
      if (validatedCells.length === 0) {
        console.log(`⚠️ Aucune cellule jouée à effacer`);
        return;
      }
      
      const toErase = Math.min(2, validatedCells.length);
      const erasedCells = [];
      
      for (let i = 0; i < toErase; i++) {
        const randomIndex = Math.floor(Math.random() * validatedCells.length);
        const cell = validatedCells.splice(randomIndex, 1)[0];
        
        opponent.grid[cell.row][cell.col] = 0;
        erasedCells.push(cell);
      }
      
      opponent.progress = calculateProgress(opponent.grid);
      opponent.correctMoves = Math.max(0, opponent.correctMoves - toErase);
      
      if (room.gameMode === 'powerup' || room.gameMode === 'timeAttackPowerup') {
        opponent.combo = 0;
        opponent.energy = 0;
      }
      
      console.log(`🗑️ ${player.playerName} EFFACE ${toErase} cellule(s) → ${opponent.playerName} Progress=${opponent.progress}/81`);
      console.log(`✅ Événement cells_erased envoyé`);
      
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
        
        io.to(opponentSocketId).emit('stats_update', {
          correctMoves: opponent.correctMoves,
          errors: opponent.errors,
          combo: opponent.combo,
          energy: opponent.energy,
          progress: opponent.progress,
          currentScore: opponent.currentScore
        });
      }
      
      io.to(player.socketId).emit('opponentProgress', {
        progress: opponent.progress,
        correctMoves: opponent.correctMoves,
        errors: opponent.errors,
        combo: opponent.combo,
        energy: opponent.energy
      });
      
      return;
    }

    // ✅✅✅ POWER-UPS NORMAUX (fog/stun/flash/shake)
    const targetSelf = Math.random() < 0.20;

    console.log(`🎯 CIBLE: ${targetSelf ? 'KARMA (20% - soi-même)' : 'ADVERSAIRE (80%)'}`);

    if (targetSelf) {
      const playerSocket = io.sockets.sockets.get(player.socketId);
      if (!playerSocket || !playerSocket.connected) {
        console.log(`❌ Socket lanceur déconnecté - REMBOURSEMENT`);
        
        player.energy++;
        io.to(player.socketId).emit('stats_update', {
          correctMoves: player.correctMoves,
          errors: player.errors,
          combo: player.combo,
          energy: player.energy,
          progress: player.progress,
          currentScore: player.currentScore
        });
        
        return;
      }
      
      if (player.activePowerUp) {
        console.log(`⚠️ ${player.playerName} a déjà un effet actif: ${player.activePowerUp.type} - REMBOURSEMENT`);
        
        player.energy++;
        io.to(player.socketId).emit('stats_update', {
          correctMoves: player.correctMoves,
          errors: player.errors,
          combo: player.combo,
          energy: player.energy,
          progress: player.progress,
          currentScore: player.currentScore
        });
        
        io.to(player.socketId).emit('powerup_blocked', {
          reason: 'self_already_active',
          message: 'Vous avez déjà un effet actif !',
          refundedEnergy: player.energy
        });
        
        return;
      }
      
      player.activePowerUp = {
        type: randomPower.type,
        expiresAt: Date.now() + randomPower.duration
      };
      
      console.log(`📤 ENVOI powerup_triggered au LANCEUR (karma)`);
      
      socket.emit('powerup_triggered', {
        type: randomPower.type,
        duration: randomPower.duration
      });
      
      setTimeout(() => {
        if (player.activePowerUp?.type === randomPower.type) {
          player.activePowerUp = null;
          console.log(`🔓 Effet ${randomPower.type} terminé pour ${player.playerName}`);
        }
      }, randomPower.duration);
      
    } else {
      if (!opponentSocketId) {
        console.log(`❌ OpponentSocketId NULL - REMBOURSEMENT`);
        
        player.energy++;
        io.to(player.socketId).emit('stats_update', {
          correctMoves: player.correctMoves,
          errors: player.errors,
          combo: player.combo,
          energy: player.energy,
          progress: player.progress,
          currentScore: player.currentScore
        });
        
        return;
      }
      
      const opponentSocket = io.sockets.sockets.get(opponentSocketId);
      if (!opponentSocket || !opponentSocket.connected) {
        console.log(`❌ Socket adversaire déconnecté - REMBOURSEMENT`);
        
        player.energy++;
        io.to(player.socketId).emit('stats_update', {
          correctMoves: player.correctMoves,
          errors: player.errors,
          combo: player.combo,
          energy: player.energy,
          progress: player.progress,
          currentScore: player.currentScore
        });
        
        return;
      }
      
      const opponentId = Object.keys(room.players).find(id => id !== playerId);
      const opponent = room.players[opponentId];
      
      if (opponent.activePowerUp) {
        console.log(`⚠️ ${opponent.playerName} a déjà un effet actif: ${opponent.activePowerUp.type} - REMBOURSEMENT`);
        
        player.energy++;
        io.to(player.socketId).emit('stats_update', {
          correctMoves: player.correctMoves,
          errors: player.errors,
          combo: player.combo,
          energy: player.energy,
          progress: player.progress,
          currentScore: player.currentScore
        });
        
        io.to(player.socketId).emit('powerup_blocked', {
          reason: 'opponent_already_active',
          message: 'L\'adversaire a déjà un effet actif !',
          refundedEnergy: player.energy
        });
        
        return;
      }
      
      opponent.activePowerUp = {
        type: randomPower.type,
        expiresAt: Date.now() + randomPower.duration
      };
      
      console.log(`📤 ENVOI powerup_triggered à l'ADVERSAIRE`);
      
      io.to(opponentSocketId).emit('powerup_triggered', {
        type: randomPower.type,
        duration: randomPower.duration
      });
      
      setTimeout(() => {
        if (opponent.activePowerUp?.type === randomPower.type) {
          opponent.activePowerUp = null;
          console.log(`🔓 Effet ${randomPower.type} terminé pour ${opponent.playerName}`);
        }
      }, randomPower.duration);
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
      } else {
        finishedGames[opponentId] = { result, timestamp: Date.now() };
      }
      
      if (abandonedConnected) {
        io.to(abandoned.socketId).emit('game_over', result);
      } else {
        finishedGames[playerId] = { result, timestamp: Date.now() };
      }
    }
    
    Object.values(room.players).forEach(p => {
      if (p.inactivityTimer) clearTimeout(p.inactivityTimer);
      if (p.timeAttackTimer) clearTimeout(p.timeAttackTimer);
    });
    
    // ✅ CLEANUP DRAIN INTERVAL
    if (room.drainInterval) {
      clearInterval(room.drainInterval);
    }
    
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
              } else {
                finishedGames[opponentId] = { result, timestamp: Date.now() };
              }
              
              finishedGames[disconnected.playerId] = { result, timestamp: Date.now() };
            }
            
            Object.values(room.players).forEach(p => {
              if (p.inactivityTimer) clearTimeout(p.inactivityTimer);
              if (p.timeAttackTimer) clearTimeout(p.timeAttackTimer);
            });
            
            // ✅ CLEANUP DRAIN INTERVAL
            if (room.drainInterval) {
              clearInterval(room.drainInterval);
            }
            
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
    message: 'Sudoku Server v16 - POOL SYSTEM CORRIGÉ',
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
          energy: rooms[id].players[pid].energy,
          currentScore: rooms[id].players[pid].currentScore
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

  server.listen(PORT, () => {
    console.log(`🚀 Serveur v16 - POOL SYSTEM CORRIGÉ sur port ${PORT}`);
    console.log(`🌐 Health: http://localhost:${PORT}/health`);
    console.log(`📊 Stats: http://localhost:${PORT}/stats`);
    
    setTimeout(() => {
      isServerReady = true;
      console.log('✅✅✅ SERVEUR PRÊT - Acceptation des matchs activée');
    }, 3000);
  });
