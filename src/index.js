const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const port = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// 存储组播地址列表
let multicastList = [];

// ffprobe检测函数
// 缓存检测结果
const streamCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

function ffprobeCheck(fullUrl, callback) {
    // 检查缓存
    const now = Date.now();
    const cached = streamCache.get(fullUrl);
    if (cached && (now - cached.timestamp) < CACHE_DURATION) {
        return callback(cached.data);
    }

    // 使用json格式输出，便于解析
    const cmd = `ffprobe -v quiet -print_format json -select_streams v:0 -show_streams "${fullUrl}"`;
    exec(cmd, { timeout: 8000 }, (error, stdout, stderr) => {
        let isAvailable = false;
        let frameRate = null;
        let bitRate = null;
        let resolution = null;
        let codec_name = null;
        let raw = null;
        try {
            if (!error && stdout) {
                const json = JSON.parse(stdout);
                raw = json;
                if (json.streams && json.streams.length > 0) {
                    const stream = json.streams[0];
                    isAvailable = stream.codec_type === 'video';
                    codec_name = stream.codec_name || null;
                    if (stream.width && stream.height) {
                        resolution = `${stream.width}x${stream.height}`;
                    }
                    bitRate = stream.bit_rate ? parseInt(stream.bit_rate) : null;
                    // 帧率
                    if (stream.r_frame_rate && stream.r_frame_rate.includes('/')) {
                        const [num, den] = stream.r_frame_rate.split('/').map(Number);
                        if (!isNaN(num) && !isNaN(den) && den !== 0) {
                            frameRate = (num / den).toFixed(2);
                        }
                    }
                }
            }
        } catch (e) {
            // 解析异常
        }
        // 计算网速
        let speed = null;
        if (bitRate) {
            speed = (bitRate / 8 / 1024).toFixed(2) + ' KB/s';
        }
        const result = {
            isAvailable,
            frameRate,
            bitRate,
            speed,
            resolution,
            codec: codec_name,
            raw // 返回原始ffprobe json数据，便于前端调试
        };
        // 缓存
        streamCache.set(fullUrl, { data: result, timestamp: Date.now() });
        callback(result);
    });
}

// 单条检测用ffprobe
app.post('/api/check-stream', async (req, res) => {
    const { udpxyUrl, multicastUrl, name } = req.body;
    const fullUrl = `${udpxyUrl}/rtp/${multicastUrl.replace('rtp://', '')}`;
    ffprobeCheck(fullUrl, ({ isAvailable, frameRate, bitRate, speed, resolution, codec, raw }) => {
        // 更新或添加组播地址
        const existingIndex = multicastList.findIndex(item => 
            item.udpxyUrl === udpxyUrl && item.multicastUrl === multicastUrl
        );
        const streamObj = {
            udpxyUrl,
            multicastUrl,
            isAvailable,
            lastChecked: new Date().toISOString(),
            frameRate,
            bitRate,
            speed,
            resolution,
            codec,
            name: name || (existingIndex !== -1 ? multicastList[existingIndex].name : ''),
            raw // 传递原始数据
        };
        if (existingIndex !== -1) {
            multicastList[existingIndex] = { ...multicastList[existingIndex], ...streamObj };
        } else {
            multicastList.push(streamObj);
        }
        res.json({
            success: true,
            isAvailable,
            frameRate: frameRate || '-',
            bitRate: bitRate ? (bitRate / 1000000).toFixed(2) + 'Mbps' : '-',
            speed,
            resolution: resolution || '-',
            codec: codec || '-',
            name: streamObj.name,
            raw, // 返回原始数据
            message: isAvailable ? '流可访问' : '流不可访问'
        });
    });
});

// 批量检测用ffprobe并发，返回进度和详细信息
app.post('/api/check-streams-batch', async (req, res) => {
    const { udpxyUrl, multicastList: batchList } = req.body;
    if (!Array.isArray(batchList)) {
        return res.status(400).json({ success: false, message: 'multicastList必须为数组' });
    }
    // 兼容前端传参格式
    const fixedList = batchList.map(item => {
        if (typeof item === 'string') {
            const [name, multicastUrl] = item.split(',');
            return { name: name ? name.trim() : '', multicastUrl: multicastUrl ? multicastUrl.trim() : '' };
        }
        return item;
    }).filter(item => item.multicastUrl && item.multicastUrl.startsWith('rtp://'));
    if (fixedList.length === 0) {
        return res.status(400).json({ success: false, message: '无有效组播地址' });
    }
    const limit = 5;
    let idx = 0;
    const results = [];
    let finished = 0;
    async function runNext(progressCallback) {
        if (idx >= fixedList.length) return;
        const item = fixedList[idx++];
        const multicastUrl = item.multicastUrl || item;
        const name = item.name || '';
        const fullUrl = `${udpxyUrl}/rtp/${multicastUrl.replace('rtp://', '')}`;
        await new Promise((resolve) => {
            ffprobeCheck(fullUrl, ({ isAvailable, frameRate, bitRate, speed, resolution, codec }) => {
                results.push({
                    ...item,
                    udpxyUrl,
                    multicastUrl,
                    isAvailable,
                    lastChecked: new Date().toISOString(),
                    frameRate: frameRate || '-',
                    bitRate: bitRate ? (bitRate / 1000000).toFixed(2) + 'Mbps' : '-',
                    speed,
                    resolution: resolution || '-',
                    codec: codec || 'h264',
                    name,
                    message: isAvailable ? '流可访问' : '流不可访问'
                });
                finished++;
                if (progressCallback) progressCallback(finished, fixedList.length, name, multicastUrl, frameRate, bitRate, speed);
                resolve();
            });
        });
        await runNext(progressCallback);
    }
    await Promise.all(Array(limit).fill(0).map(() => runNext(null)));
    // 合并到全局multicastList
    results.forEach(result => {
        const existingIndex = multicastList.findIndex(item =>
            item.udpxyUrl === udpxyUrl && item.multicastUrl === result.multicastUrl
        );
        if (existingIndex !== -1) {
            multicastList[existingIndex] = { ...multicastList[existingIndex], ...result };
        } else {
            multicastList.push(result);
        }
    });
    res.json({ success: true, results });
});

// 获取所有组播地址
app.get('/api/streams', (req, res) => {
    res.json({ success: true, streams: multicastList });
});

// 删除组播地址
app.delete('/api/stream/:index', (req, res) => {
    const index = parseInt(req.params.index);
    if (index >= 0 && index < multicastList.length) {
        multicastList.splice(index, 1);
        res.json({ success: true, message: '删除成功' });
    } else {
        res.status(400).json({ success: false, message: '无效的索引' });
    }
});
// 清空所有组播地址
app.delete('/api/streams', (req, res) => {
    multicastList = [];
    res.json({ success: true, message: '已清空所有检测结果' });
});

// 新增：强制刷新检测，前端传递force参数，后端清空所有检测数据
app.post('/api/force-refresh', (req, res) => {
    multicastList = [];
    streamCache.clear();
    res.json({ success: true, message: '已强制清空所有检测数据' });
});

// 提供前端页面
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(port, () => {
    console.log(`服务器运行在 http://localhost:${port}`);
});