// เซิร์ฟเวอร์ Node เล็ก ๆ รับข้อมูลที่ Worker ส่งต่อ นับขนาดและ sha256 แล้วตอบกลับ
import http from 'node:http';
import crypto from 'node:crypto';

http
  .createServer((req, res) => {
    const h = crypto.createHash('sha256');
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      h.update(c);
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ size, sha256: h.digest('hex'), chunked: req.headers['transfer-encoding'] || null }));
    });
  })
  .listen(8788, '127.0.0.1', () => console.log('sink ready 8788'));
