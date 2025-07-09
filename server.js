const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const express = require('express');
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Store All Users And Matches
let users = {};
let matches = new Map()
let games = {};
const game_settings = {
  question_count: 5,
  round_rest: 5000, // 5秒间隔
  answerTimeout: 10000 // 10秒答题时间
};


// Connection Settings
const server = http.createServer(app);
const io = socketIo(server);
io.on('connection', (socket) => {
  socket.on('setUsername', (username) => {
    if (username) {
      users[socket.id] = username;
      console.log(`User ${username} connected.`);
    }
  });

  socket.on('disconnect', () => {
    const username = users[socket.id];
    if (username) {
      console.log(`User ${username} disconnected.`);
      delete users[socket.id];
    } //这里可以添加没有用户名的条件从而了解是否有无名用户刷新或离开页面；
  });

  socket.on('get_online_users', () => {
    socket.emit('online_users', Object.values(users));
  });

  // Receive challenge with from_name and to_name
  socket.on('start_challenge', (from_name, to_name) => {
    // Check if the target user is online
    const target_user_online = Object.values(users).includes(to_name);
    
    if (target_user_online) {
      const target_id = Object.keys(users).find(
        (key) => users[key] === to_name
      );
      io.to(target_id).emit('receive_challenge', {
        from: from_name, // 添加发起者字段
        to: to_name,     // 添加目标字段
        message: `You have a new challenge from ${from_name}!`,
      });

      console.log(`Challenge sent from ${from_name} to ${to_name}`);
    } else {
      const source_id = Object.keys(users).find(
        (key) => users[key] === from_name
      );
      console.log(`${to_name} is not online.`);
      socket.emit('not_online', `${to_name} is not online.`);
      io.to(source_id).emit('one_not_online')
    }
  });

  socket.on('accept_challenge',(acceptor, challenger) => {
    // Check if the target user is online
    const challenger_online = Object.values(users).includes(challenger);
    const acceptor_online = Object.values(users).includes(acceptor);
    
    if (challenger_online & acceptor_online) {
      // Find the socket ID of both of them
      const challenger_id = Object.keys(users).find(
        (key) => users[key] === challenger
      );
      const acceptor_id = Object.keys(users).find(
        (key) => users[key] === acceptor
      );

      // Connected, remind both of them
      io.to(challenger_id).emit('players_matched', {challenger, acceptor});
      io.to(acceptor_id).emit('players_matched', {acceptor, challenger});
      console.log(`The match between ${acceptor} and ${challenger} is ready!`);
    } else {
      console.log(`Opponent is not online.`);
      io.to(challenger_id).emit('one_not_online');
      io.to(acceptor_id).emit('one_not_online');
    }
  });

  socket.on('reject_challenge',(rejector, challenger) => {
    const challenger_id = Object.keys(users).find(
        key => users[key] === challenger
    )
    if (challenger_id) {
        io.to(challenger_id).emit('challenge_be_rejected');
        console.log(`The match between ${rejector} and ${challenger} has been rejected!`);
    } 
  });

  socket.on('already_in_challenge',(busy_user, free_user) => {
    console.log(`${busy_user} is busy, request returned to ${free_user}!`)
    const free_user_id = Object.keys(users).find(
      key => users[key] === free_user
    )

    if (free_user_id){
      io.to(free_user_id).emit('oppo_busy',busy_user);
    }
  });

  socket.on('player_ready', (self, oppo) => {
    const match_key = [self, oppo].sort().join(':');
    
    // 初始化游戏会话
    if (!games[match_key]) { // 仅当会话不存在时才初始化
        games[match_key] = {
            current_question: 0,
            scores: { [self]: 0, [oppo]: 0 },
            playersReady: 0,
            timer: null,
            results: {},
    };
}

    const status = matches.get(match_key) || {};
    status[self] = true;

    // 添加调试日志
    console.log(`Player ready: ${self} | Match status:`, status);
    
    if (status[oppo]) {
      const self_id = Object.keys(users).find(id => users[id] === self);
      const oppo_id = Object.keys(users).find(id => users[id] === oppo);

      io.to(self_id).emit('game_start', { opponent: oppo });
      io.to(oppo_id).emit('game_start', { opponent: self });
      
      console.log(`Game start emitted to ${self} and ${oppo}`);
      matches.delete(match_key);
    } else {
      console.log('对面没准备好')
      matches.set(match_key, status);
    }
  });

    // 接收客户端提交的答题结果
  socket.on('submit_result', (data) => {
    const match_key = [data.player, data.opponent].sort().join(':');
    const session = games[match_key];

    // 新增：检查会话是否存在
    if (!session) {
        console.error(`[ERROR] Session not found for match key: ${match_key}`);
        return; // 直接返回，避免后续操作
    }
    
    // 记录结果
    if (!session.results) session.results = {};
    session.results[data.player] = {
      is_correct: data.is_correct,
      response_time: data.response_time,
      score: data.score
    };

    // 当两个结果都收到时处理
    if (Object.keys(session.results).length === 2) {
      clearTimeout(session.timer);
      processRoundResults(match_key, session);
    }
  });

  function processRoundResults(match_key, session) {
    const players = Object.keys(session.scores);
    const [playerA, playerB] = players;

    // 1. 处理未提交的玩家（超时/断线）
    if (!session.results[playerA]) {
        session.results[playerA] = { is_correct: false, response_time: Infinity };
    }
    if (!session.results[playerB]) {
        session.results[playerB] = { is_correct: false, response_time: Infinity };
    }

    // 2. 提取双方结果
    const resultA = session.results[playerA];
    const resultB = session.results[playerB];

    // 3. 初始化本轮得分
    let scoreA = 0, scoreB = 0;

    // 4. 核心计分规则
    if (resultA.is_correct && resultB.is_correct) {
        // 双方正确，比较响应时间
        if (resultA.response_time < resultB.response_time) {
        scoreA = 2;
        scoreB = 1;
        } else {
        scoreB = 2;
        scoreA = 1;
        }
    } else if (resultA.is_correct) {
        // 仅A正确
        scoreA = 2;
    } else if (resultB.is_correct) {
        // 仅B正确
        scoreB = 2;
    } else {
        // 双方错误都不得分
    }

    // 5. 更新总分
    session.scores[playerA] += scoreA;
    session.scores[playerB] += scoreB;

    // 广播本轮结果

    
    players.forEach(player => {
      const opponent = players.find(p => p !== player);
      const player_id = Object.keys(users).find(id => users[id] === player);
      
      io.to(player_id).emit('round_complete', {
        scores: session.scores,
        current_question: session.current_question,
        is_correct: session.results[player].is_correct
      });
    });

    // 准备下一题
    session.current_question++;
    delete session.results;
    
    if (session.current_question < game_settings.question_count) {
      // 5秒后通知客户端加载下一题
      setTimeout(() => {
        players.forEach(player => {
          const player_id = Object.keys(users).find(id => users[id] === player);
          io.to(player_id).emit('prepare_next', {
            questionNumber: session.current_question
          });
        });
      }, game_settings.round_rest);
    } else {
      // 游戏结束
      let winner;
      if (session.scores[players[0]] > session.scores[players[1]]){
        winner = players[0];
      }else if (session.scores[players[0]] < session.scores[players[1]]){
        winner = players[1];
      }else{
        winner = "Both Of You";
      }
      const fin_result = {
        scores: session.scores,
        winner: winner,
      };
      players.forEach(player => {
        const player_id = Object.keys(users).find(id => users[id] === player);
        io.to(player_id).emit('game_over', fin_result);
      });
      delete games[match_key];
    }
   }
});

// Start Server
server.listen(8080, () => {
  console.log('Server running on http://localhost:8080');
});