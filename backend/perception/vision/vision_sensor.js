import { ScreenModel } from '../screen_model.js';
import { PNG } from 'pngjs';

// ---- Image processing functions ----

function downsampleBy2(rgba, width, height) {
    const newW = Math.floor(width / 2);
    const newH = Math.floor(height / 2);
    const newRgba = new Uint8Array(newW * newH * 4);
    for (let y = 0; y < newH; y++) {
        for (let x = 0; x < newW; x++) {
            const srcIdx = ((y * 2) * width + (x * 2)) * 4;
            const dstIdx = (y * newW + x) * 4;
            newRgba[dstIdx] = rgba[srcIdx];
            newRgba[dstIdx + 1] = rgba[srcIdx + 1];
            newRgba[dstIdx + 2] = rgba[srcIdx + 2];
            newRgba[dstIdx + 3] = rgba[srcIdx + 3];
        }
    }
    return { data: newRgba, width: newW, height: newH };
}

function downsample(rgba, width, height) {
    // 1/4 resolution means downsample twice
    const half = downsampleBy2(rgba, width, height);
    return downsampleBy2(half.data, half.width, half.height);
}

function toGrayscale(rgba, width, height) {
    const gray = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
        const r = rgba[i * 4];
        const g = rgba[i * 4 + 1];
        const b = rgba[i * 4 + 2];
        gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
    return gray;
}

function sobelEdgeDetect(gray, width, height) {
    const edges = new Uint8Array(width * height);
    const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
    const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            let sumX = 0;
            let sumY = 0;
            for (let ky = -1; ky <= 1; ky++) {
                for (let kx = -1; kx <= 1; kx++) {
                    const val = gray[(y + ky) * width + (x + kx)];
                    const wIdx = (ky + 1) * 3 + (kx + 1);
                    sumX += val * gx[wIdx];
                    sumY += val * gy[wIdx];
                }
            }
            let magnitude = Math.sqrt(sumX * sumX + sumY * sumY);
            if (magnitude > 255) magnitude = 255;
            edges[y * width + x] = magnitude;
        }
    }
    return edges;
}

function thresholdBinary(edges, threshold) {
    const binary = new Uint8Array(edges.length);
    for (let i = 0; i < edges.length; i++) {
        binary[i] = edges[i] > threshold ? 1 : 0;
    }
    return binary;
}

function connectedComponentLabeling(binary, width, height) {
    const labels = new Int32Array(width * height);
    let currentLabel = 1;
    const parent = [0]; // union-find

    function find(i) {
        let root = i;
        while (parent[root] !== root) {
            root = parent[root];
        }
        let curr = i;
        while (curr !== root) {
            let nxt = parent[curr];
            parent[curr] = root;
            curr = nxt;
        }
        return root;
    }

    function union(i, j) {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) {
            parent[rootI] = rootJ;
        }
    }

    // First pass
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (binary[y * width + x] === 1) {
                const top = y > 0 ? labels[(y - 1) * width + x] : 0;
                const left = x > 0 ? labels[y * width + (x - 1)] : 0;
                
                if (top === 0 && left === 0) {
                    labels[y * width + x] = currentLabel;
                    parent[currentLabel] = currentLabel;
                    currentLabel++;
                } else if (top !== 0 && left === 0) {
                    labels[y * width + x] = top;
                } else if (top === 0 && left !== 0) {
                    labels[y * width + x] = left;
                } else {
                    labels[y * width + x] = Math.min(top, left);
                    union(top, left);
                }
            }
        }
    }

    // Second pass
    for (let i = 1; i < currentLabel; i++) {
        parent[i] = find(i);
    }

    for (let i = 0; i < labels.length; i++) {
        if (labels[i] > 0) {
            labels[i] = parent[labels[i]];
        }
    }

    return { labels, numLabels: currentLabel };
}

function extractRegionBboxes(labels, width, height, numLabels) {
    const bboxes = {};
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const label = labels[y * width + x];
            if (label > 0) {
                if (!bboxes[label]) {
                    bboxes[label] = { minX: x, minY: y, maxX: x, maxY: y, count: 0 };
                } else {
                    if (x < bboxes[label].minX) bboxes[label].minX = x;
                    if (x > bboxes[label].maxX) bboxes[label].maxX = x;
                    if (y < bboxes[label].minY) bboxes[label].minY = y;
                    if (y > bboxes[label].maxY) bboxes[label].maxY = y;
                }
                bboxes[label].count++;
            }
        }
    }
    return Object.values(bboxes);
}

function analyzeRegionColor(rgba, width, height, bbox) {
    let rSum = 0, gSum = 0, bSum = 0;
    let count = 0;
    for (let y = bbox.minY; y <= bbox.maxY; y++) {
        for (let x = bbox.minX; x <= bbox.maxX; x++) {
            const idx = (y * width + x) * 4;
            rSum += rgba[idx];
            gSum += rgba[idx + 1];
            bSum += rgba[idx + 2];
            count++;
        }
    }
    if (count === 0) return { r: 0, g: 0, b: 0 };
    return {
        r: Math.round(rSum / count),
        g: Math.round(gSum / count),
        b: Math.round(bSum / count)
    };
}

function classifyByColor(r, g, b) {
    const isBlue = b > r + 30 && b > g + 30;
    const isRed = r > g + 30 && r > b + 30;
    const isGreen = g > r + 30 && g > b + 30;
    const isYellow = r > b + 30 && g > b + 30 && Math.abs(r - g) < 30;
    const isGray = Math.abs(r - g) < 20 && Math.abs(r - b) < 20 && Math.abs(g - b) < 20 && r > 50 && r < 200;
    const isWhite = r > 200 && g > 200 && b > 200;
    
    if (isBlue) return { type: 'link', semanticLabel: 'button_primary' };
    if (isRed) return { type: 'error', semanticLabel: 'alert_or_close' };
    if (isGreen) return { type: 'button', semanticLabel: 'success_or_confirm' };
    if (isYellow) return { type: 'panel', semanticLabel: 'warning' };
    if (isGray) return { type: 'separator', semanticLabel: 'disabled' };
    if (isWhite) return { type: 'input_field', semanticLabel: 'panel' };
    
    return { type: 'panel', semanticLabel: 'visual_element' };
}

export class RealVisionSensor {
    constructor() {
        this.name = 'vision';
        this.lastRun = 0;
        this.interval = 1000;
    }

    canHandle() {
        return true;
    }

    read(intent) {
        const now = Date.now();
        if (now - this.lastRun < this.interval) {
            return null; // Skip if too soon
        }

        if (!intent || !intent.pngBuffer) {
            return null; // Need PNG buffer
        }

        this.lastRun = now;

        let png;
        try {
            png = PNG.sync.read(intent.pngBuffer);
        } catch (err) {
            return null; // Handle bad buffer gracefully
        }
        
        let rgba = png.data;
        let width = png.width;
        let height = png.height;

        // Downsample to 1/4 resolution
        const downsampled = downsample(rgba, width, height);
        rgba = downsampled.data;
        width = downsampled.width;
        height = downsampled.height;
        const scale = 4;

        const gray = toGrayscale(rgba, width, height);
        const edges = sobelEdgeDetect(gray, width, height);
        const binary = thresholdBinary(edges, 50);
        const ccl = connectedComponentLabeling(binary, width, height);
        let bboxes = extractRegionBboxes(ccl.labels, width, height, ccl.numLabels);

        // Filter bounds and min size
        bboxes = bboxes.filter(b => b.count > 10 && (b.maxX - b.minX) > 5 && (b.maxY - b.minY) > 5);
        bboxes = bboxes.filter(b => (b.maxX - b.minX) < width * 0.8 && (b.maxY - b.minY) < height * 0.8);

        const elements = [];
        for (const bbox of bboxes) {
            const w = bbox.maxX - bbox.minX;
            const h = bbox.maxY - bbox.minY;
            const x = bbox.minX;
            const y = bbox.minY;

            const color = analyzeRegionColor(rgba, width, height, bbox);
            const classified = classifyByColor(color.r, color.g, color.b);

            let type = classified.type;
            let role = 'visual_element';
            
            // Icon detection (original res 16-64 maps to downsampled res 4-16)
            if (w >= 4 && w <= 16 && h >= 4 && h <= 16) {
                const aspectRatio = w / h;
                if (aspectRatio > 0.5 && aspectRatio < 2.0) {
                    type = 'icon';
                }
            }

            elements.push({
                type: type,
                name: `${type}_region_${x}_${y}`,
                role: role,
                bbox: { x: x * scale, y: y * scale, w: w * scale, h: h * scale },
                coordinates: { x: (x + w/2) * scale, y: (y + h/2) * scale },
                confidence: 0.65,
                source: 'vision',
                semanticLabel: classified.semanticLabel,
                action: 'click',
            });
        }

        return new ScreenModel({
            source: 'vision',
            confidence: 0.6,
            elements: elements
        });
    }
}
