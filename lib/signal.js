function signalPid(pid, signal, { kill = (target, name) => process.kill(target, name), log = console.error } = {}) {
  try {
    kill(pid, signal);
    return true;
  } catch (error) {
    if (error.code !== 'ESRCH') log(`playwriter-project: could not send ${signal} to pid ${pid}: ${error.message}`);
    return false;
  }
}

module.exports = { signalPid };
