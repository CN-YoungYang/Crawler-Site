// 上海时区日期（Intl 标准库，en-CA 直接产出 YYYY-MM-DD，Asia/Shanghai 无夏令时）
function shanghaiDateStr(offsetDays = 0, nowMs = Date.now()) {
  const d = new Date(nowMs + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const fs = require('fs');

// xlsx 魔数校验（zip PK\x03\x04），抽公用避免 crawler/report 各自重复
function hasValidXlsxHeader(filePath) {
  let fd;
  try {
    const head = Buffer.alloc(4);
    fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, head, 0, 4, 0);
    return bytesRead >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

module.exports = { shanghaiDateStr, hasValidXlsxHeader };
