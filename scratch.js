
const fs = require('fs');
const p = 'e:/Reddit task/task-claimer/content/interceptor.js';
let code = fs.readFileSync(p, 'utf8');

const splitToken = '// --- Handle Incoming WS Messages -------------------------';
const parts = code.split(splitToken);

if (parts.length === 2) {
  const newEnd = \
  function handleIncomingMessage(d) {
    if (d.type === 'Transition') {
      var mods = d.modifications;
      if (!mods) return;
      for (var i = 0; i < mods.length; i++) {
        var mod = mods[i];
        if (mod.type === 'QueryUpdated' && mod.value && mod.value.tasks) {
          onTasksReceived(mod.value.tasks);
        }
      }
    }
  }

  function onTasksReceived(tasks) {
    if (!config.clerkId) return;

    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (!t._id || acceptedTaskIds[t._id]) continue;
      acceptedTaskIds[t._id] = true;

      origSendFn(JSON.stringify({
        type: 'Mutation',
        requestId: requestIdCounter++,
        udfPath: 'tasks/index:acceptTask',
        args: [{ clerkId: config.clerkId, taskId: t._id }]
      }));
    }
  }

  // --- Expose for debugging -------------------------------
  window.__WSBot = {
    getState: function () {
      return {
        connected: !!(convexWS && convexWS.readyState === OrigWebSocket.OPEN),
        hasAuth: !!authToken,
        config: config,
        isAccepting: isAccepting,
        queryMap: queryIdMap,
        acceptedCount: Object.keys(acceptedTaskIds).length,
        skippedCount: Object.keys(skippedTaskIds).length,
        pendingAccepts: pendingAccepts,
      };
    },
  };

  console.log('[WS-Bot] ?? Interceptor installed (MAIN world) — waiting for Convex WS...');
})();
\;
  fs.writeFileSync(p, parts[0] + splitToken + '\\n' + newEnd, 'utf8');
  console.log('Replaced successfully');
} else {
  console.log('Could not find split token');
}

