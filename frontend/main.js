import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import gsap from 'gsap';

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const NUM_PARTICLES = 50000;
const BLACK_THRESHOLD = 25;           // RGB sum below this = background pixel, skip
const WHITE_THRESHOLD = 690;          // RGB sum above this = white background, skip (max 765)
const IMAGE_FIT_WIDTH = 600;          // target width in 3D world units
const Z_JITTER = 8;                   // slight depth variation for assembled image
const MIN_BRIGHTNESS = 0.35;          // boost dim pixels so they're visible with additive blending
const FRAME_INTERVAL_MS = 100;
const DEFAULT_REMOTE_WS_URL = 'wss://amandeep-kaisen.onrender.com';

const IMAGE_MAP = {
    infinite_void: '/infinite_void.jpg',
    mahoraga: '/mahoraga.jpg',
    malevolent_shrine: '/malevolent_shrine.jpg',
    hollow_purple: '/hollow_purple.jpg',
};

// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────
let scene, camera, renderer, composer;
let particles, geometry;
let ws;
let socket;

let scatteredPositions = new Float32Array(NUM_PARTICLES * 3);
let scatteredColors = new Float32Array(NUM_PARTICLES * 3);

// { gestureName: { positions: Float32Array, colors: Float32Array } }
const formations = {};

let progressObj = { val: 0 };
let targetGesture = 'neutral';
let currentFormationKey = null;               // tracks which formation we are in / going to

// ─────────────────────────────────────────────
//  BOOTSTRAP
// ─────────────────────────────────────────────
init();
animate();

// ─────────────────────────────────────────────
//  PIXEL EXTRACTION
// ─────────────────────────────────────────────

/**
 * Load an image URL and extract non-background pixel data.
 * Returns array of { x, y, r, g, b } in pixel-space.
 */
function extractPixelData(imagePath) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            const canvas = document.getElementById('pixel-canvas');
            const ctx = canvas.getContext('2d', { willReadFrequently: true });

            // Determine a downscale factor so total pixels ~ NUM_PARTICLES * 2
            // (we'll subsample later; having 2x headroom gives better coverage)
            const targetPixels = NUM_PARTICLES * 2;
            const aspect = img.width / img.height;
            let drawW = Math.round(Math.sqrt(targetPixels * aspect));
            let drawH = Math.round(drawW / aspect);

            canvas.width = drawW;
            canvas.height = drawH;

            ctx.clearRect(0, 0, drawW, drawH);
            ctx.drawImage(img, 0, 0, drawW, drawH);

            const imageData = ctx.getImageData(0, 0, drawW, drawH);
            const data = imageData.data;

            const pixels = [];
            for (let y = 0; y < drawH; y++) {
                for (let x = 0; x < drawW; x++) {
                    const idx = (y * drawW + x) * 4;
                    const r = data[idx];
                    const g = data[idx + 1];
                    const b = data[idx + 2];
                    const a = data[idx + 3];

                    const rgbSum = r + g + b;

                    // Skip transparent, near-black, or near-white (background) pixels
                    if (a < 20) continue;
                    if (rgbSum < BLACK_THRESHOLD) continue;
                    if (rgbSum > WHITE_THRESHOLD) continue;

                    // Normalize to 0-1
                    let nr = r / 255;
                    let ng = g / 255;
                    let nb = b / 255;

                    // Boost dim pixels so they're visible with additive blending
                    const maxChannel = Math.max(nr, ng, nb);
                    if (maxChannel > 0 && maxChannel < MIN_BRIGHTNESS) {
                        const boost = MIN_BRIGHTNESS / maxChannel;
                        nr *= boost;
                        ng *= boost;
                        nb *= boost;
                    }

                    pixels.push({ x, y, r: nr, g: ng, b: nb });
                }
            }

            console.log(`[PixelExtract] ${imagePath}: ${drawW}x${drawH} → ${pixels.length} qualifying pixels`);
            resolve({ pixels, width: drawW, height: drawH });
        };
        img.onerror = () => reject(new Error(`Failed to load image: ${imagePath}`));
        img.src = imagePath;
    });
}

/**
 * Convert pixel array into Float32Array position & color buffers
 * scaled to fit the 3D camera view, centered at origin.
 */
function buildFormationArrays({ pixels, width, height }) {
    const positions = new Float32Array(NUM_PARTICLES * 3);
    const colors = new Float32Array(NUM_PARTICLES * 3);

    // Scale factor: map pixel-space height to the exact vertical viewport height
    // at the camera's Z distance (500)
    const vFOV = (camera.fov * Math.PI) / 180;
    const visibleHeight = 2 * Math.tan(vFOV / 2) * Math.abs(camera.position.z);

    const scale = visibleHeight / height;
    const halfW = (width * scale) / 2;
    const halfH = (height * scale) / 2;

    // Subsample or pad to exactly NUM_PARTICLES
    let sampledPixels;
    if (pixels.length >= NUM_PARTICLES) {
        // Randomly select NUM_PARTICLES from the qualifying pixels
        sampledPixels = shuffleArray(pixels).slice(0, NUM_PARTICLES);
    } else {
        // Use all pixels, then fill remainder with "aura" positions
        sampledPixels = [...pixels];
    }

    for (let i = 0; i < NUM_PARTICLES; i++) {
        const i3 = i * 3;

        if (i < sampledPixels.length) {
            const p = sampledPixels[i];
            // Convert pixel coords to centered 3D coords (Y flipped)
            positions[i3] = p.x * scale - halfW;                           // X
            positions[i3 + 1] = -(p.y * scale - halfH);                       // Y (flip)
            positions[i3 + 2] = (Math.random() - 0.5) * Z_JITTER;            // Z jitter

            colors[i3] = p.r;
            colors[i3 + 1] = p.g;
            colors[i3 + 2] = p.b;
        } else {
            // "Aura" particle — scattered behind the image with dim glow
            const angle = Math.random() * Math.PI * 2;
            const radius = IMAGE_FIT_WIDTH * 0.3 + Math.random() * IMAGE_FIT_WIDTH * 0.5;
            positions[i3] = Math.cos(angle) * radius;
            positions[i3 + 1] = Math.sin(angle) * radius * (height / width);
            positions[i3 + 2] = -20 + (Math.random() - 0.5) * 40;

            // Dim version of image's average color (gives an ambient glow)
            colors[i3] = 0.15;
            colors[i3 + 1] = 0.15;
            colors[i3 + 2] = 0.2;
        }
    }

    return { positions, colors };
}

/**
 * Fisher-Yates shuffle (in-place, returns same reference)
 */
function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * Preload all image formations at startup.
 */
async function preloadAllFormations() {
    const entries = Object.entries(IMAGE_MAP);
    const total = entries.length;
    let loaded = 0;

    const hud = document.getElementById('status-hud');

    for (const [gesture, path] of entries) {
        try {
            hud.innerText = `Loading Domain: ${gesture.toUpperCase()} (${loaded + 1}/${total})...`;
            const pixelData = await extractPixelData(path);
            formations[gesture] = buildFormationArrays(pixelData);
            loaded++;
            console.log(`[Preload] ✓ ${gesture} formation ready (${formations[gesture].positions.length / 3} particles)`);
        } catch (e) {
            console.error(`[Preload] ✗ Failed to load ${gesture}:`, e);
        }
    }

    hud.innerText = `All Domains Loaded (${loaded}/${total}). Connecting...`;
    console.log(`[Preload] All formations ready.`);
}

// ─────────────────────────────────────────────
//  THREE.JS INIT
// ─────────────────────────────────────────────
async function init() {
    setupWebcam();

    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x000000, 0.0015);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2500);
    camera.position.z = 500;
    camera.position.y = 50;

    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 1);
    document.getElementById('webgl-container').appendChild(renderer.domElement);

    // Post processing
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        2.5, 0.5, 0.1
    );
    composer.addPass(bloomPass);

    // Geometry & initial scattered state
    geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(NUM_PARTICLES * 3);
    const colors = new Float32Array(NUM_PARTICLES * 3);

    for (let i = 0; i < NUM_PARTICLES; i++) {
        // Scattered positions
        scatteredPositions[i * 3] = (Math.random() - 0.5) * 2000;
        scatteredPositions[i * 3 + 1] = (Math.random() - 0.5) * 2000;
        scatteredPositions[i * 3 + 2] = (Math.random() - 0.5) * 2000;

        // Scattered colors (soft white/grey randomness)
        scatteredColors[i * 3] = 0.5 + Math.random() * 0.5;
        scatteredColors[i * 3 + 1] = 0.5 + Math.random() * 0.5;
        scatteredColors[i * 3 + 2] = 0.5 + Math.random() * 0.5;

        // Initial state = scattered
        positions[i * 3] = scatteredPositions[i * 3];
        positions[i * 3 + 1] = scatteredPositions[i * 3 + 1];
        positions[i * 3 + 2] = scatteredPositions[i * 3 + 2];
        colors[i * 3] = scatteredColors[i * 3];
        colors[i * 3 + 1] = scatteredColors[i * 3 + 1];
        colors[i * 3 + 2] = scatteredColors[i * 3 + 2];
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
        size: 2.0,
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0.9,
    });

    particles = new THREE.Points(geometry, material);
    scene.add(particles);

    window.addEventListener('resize', onWindowResize);

    // Preload all image formations BEFORE connecting WebSocket
    await preloadAllFormations();

    setupWebSocket();
    setupKeyboardShortcuts();
}

// ─────────────────────────────────────────────
//  WEBCAM
// ─────────────────────────────────────────────
function setupWebcam() {
    const video = document.getElementById('webcam');
    const captureCanvas = document.createElement('canvas');
    const captureCtx = captureCanvas.getContext('2d');

    if (!video || !captureCtx) {
        console.error('Webcam element (#webcam) not found.');
        return;
    }

    const uploadInput = document.getElementById('upload-video');
    const cameraMessage = document.getElementById('camera-message');

    function startCaptureFromVideoElem(srcVideo) {
        srcVideo.style.display = 'block';
        srcVideo.play().catch(() => { });

        const localCanvas = document.createElement('canvas');
        const localCtx = localCanvas.getContext('2d');

        const intervalId = setInterval(() => {
            if (typeof socket !== 'undefined' && socket.readyState === WebSocket.OPEN) {
                if (srcVideo.videoWidth > 0) {
                    localCanvas.width = srcVideo.videoWidth;
                    localCanvas.height = srcVideo.videoHeight;
                    localCtx.drawImage(srcVideo, 0, 0, localCanvas.width, localCanvas.height);
                    const base64String = localCanvas.toDataURL('image/jpeg', 0.5);
                    try { socket.send(JSON.stringify({ image: base64String })); } catch (e) { /* ignore */ }
                }
            }
        }, FRAME_INTERVAL_MS);

        return () => clearInterval(intervalId);
    }

    // Try real camera first
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ video: true })
            .then((stream) => {
                console.log('SUCCESS: Camera permission granted!');
                video.srcObject = stream;
                const stopInterval = startCaptureFromVideoElem(video);
                // when page unloads, stop the tracks
                window.addEventListener('beforeunload', () => {
                    try { stream.getTracks().forEach(t => t.stop()); } catch (e) { }
                    stopInterval();
                });
            })
            .catch((err) => {
                console.warn('Camera access failed — enabling upload fallback.', err);
                video.style.display = 'none';
                cameraMessage.innerText = 'Camera blocked — upload a video or image to simulate frames.';
            });
    } else {
        console.warn('navigator.mediaDevices.getUserMedia not supported — enabling upload fallback.');
        video.style.display = 'none';
        cameraMessage.innerText = 'Camera not available — upload a video or image to simulate frames.';
    }

    // Upload fallback: user can upload a video or image to simulate the webcam
    if (uploadInput) {
        uploadInput.addEventListener('change', (ev) => {
            const file = ev.target.files && ev.target.files[0];
            if (!file) return;

            const url = URL.createObjectURL(file);

            // If image, draw it repeatedly; if video, play it and capture frames
            if (file.type.startsWith('image/')) {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => {
                    // draw and send at interval
                    const tempCanvas = document.createElement('canvas');
                    const tempCtx = tempCanvas.getContext('2d');
                    tempCanvas.width = img.width;
                    tempCanvas.height = img.height;
                    tempCtx.drawImage(img, 0, 0);
                    setInterval(() => {
                        if (typeof socket !== 'undefined' && socket.readyState === WebSocket.OPEN) {
                            const b64 = tempCanvas.toDataURL('image/jpeg', 0.8);
                            try { socket.send(JSON.stringify({ image: b64 })); } catch (e) { }
                        }
                    }, FRAME_INTERVAL_MS);
                };
                img.src = url;
                cameraMessage.innerText = 'Using uploaded image as simulated camera.';
            } else {
                // treat as video
                const uploadedVideo = document.createElement('video');
                uploadedVideo.id = 'uploaded-sim';
                uploadedVideo.muted = true;
                uploadedVideo.src = url;
                uploadedVideo.autoplay = true;
                uploadedVideo.loop = true;
                uploadedVideo.playsInline = true;
                uploadedVideo.style.display = 'none';
                document.body.appendChild(uploadedVideo);

                uploadedVideo.addEventListener('loadeddata', () => {
                    if (uploadedVideo.readyState >= 2) {
                        startCaptureFromVideoElem(uploadedVideo);
                        cameraMessage.innerText = 'Using uploaded video as simulated camera.';
                    }
                });

                // revoke object URL when page unloads
                window.addEventListener('beforeunload', () => URL.revokeObjectURL(url));
            }
        });
    }
}

// ─────────────────────────────────────────────
//  WEBSOCKET
// ─────────────────────────────────────────────
function setupWebSocket() {
    const hud = document.getElementById('status-hud');
    const configuredUrl = (import.meta.env.VITE_WS_URL || '').trim();
    const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const localFallback = `${protocol}://${window.location.hostname}:8765`;
    const wsUrl = configuredUrl || (isLocalHost ? localFallback : DEFAULT_REMOTE_WS_URL);

    ws = new WebSocket(wsUrl);
    socket = ws;

    ws.onopen = () => {
        hud.innerText = 'API Connected. Searching for Gestures...';
        hud.style.color = '#0f0';
        console.log(`[WebSocket] Connected to ${wsUrl}`);
    };

    ws.onclose = () => {
        hud.innerText = 'API Disconnected.';
        hud.style.color = '#f00';
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.gesture) {
                if (data.gesture !== 'neutral' && formations[data.gesture]) {
                    if (targetGesture !== data.gesture) {
                        assembleDomain(data.gesture);
                        updateTechniqueUI(data.gesture);
                    }
                } else if (data.gesture === 'neutral' && targetGesture !== 'neutral') {
                    assembleDomain('neutral');
                    updateTechniqueUI('neutral');
                }
            }
        } catch (e) { /* ignore malformed messages */ }
    };
}

/**
 * Update the bottom-center UI text for the current technique
 */
function updateTechniqueUI(gesture) {
    const el = document.getElementById('technique-name');
    const hud = document.getElementById('status-hud');

    if (gesture === 'neutral') {
        el.classList.remove('active');
        hud.innerText = 'Searching for Gestures...';
        return;
    }

    const mapping = {
        infinite_void: { name: 'Infinite Void', class: 'color-void' },
        malevolent_shrine: { name: 'Malevolent Shrine', class: 'color-shrine' },
        hollow_purple: { name: 'Hollow Purple', class: 'color-purple' },
        mahoraga: { name: 'Mahoraga', class: 'color-mahoraga' }
    };

    const tech = mapping[gesture];
    if (tech) {
        // Clear old classes
        el.className = '';
        el.classList.add(tech.class, 'active');
        el.innerText = tech.name;
        hud.innerText = `Domain Detected: ${tech.name.toUpperCase()}`;
    }
}

// ─────────────────────────────────────────────
//  KEYBOARD SHORTCUTS (for testing without backend)
// ─────────────────────────────────────────────
function setupKeyboardShortcuts() {
    const gestureKeys = {
        '1': 'infinite_void',
        '2': 'mahoraga',
        '3': 'malevolent_shrine',
        '4': 'hollow_purple',
        '0': 'neutral',
    };

    window.addEventListener('keydown', (e) => {
        const gesture = gestureKeys[e.key];
        if (gesture === undefined) return;

        if (gesture === 'neutral') {
            assembleDomain('neutral');
            updateTechniqueUI('neutral');
        } else if (formations[gesture]) {
            assembleDomain(gesture);
            updateTechniqueUI(gesture);
        }
    });

    console.log('[Keyboard] Shortcuts active: 1=Infinite Void, 2=Mahoraga, 3=Malevolent Shrine, 4=Hollow Purple, 0=Neutral');
}

// ─────────────────────────────────────────────
//  ASSEMBLY ANIMATION
// ─────────────────────────────────────────────
function assembleDomain(gesture) {
    targetGesture = gesture;
    const isAssembling = gesture !== 'neutral';

    // Reset mesh rotation to face camera when assembling into an image
    if (isAssembling && particles) {
        gsap.to(particles.rotation, {
            x: 0, y: 0, z: 0,
            duration: 1.2,
            ease: 'power2.inOut',
        });
    }

    // If we're assembling to a formation, track which one
    if (isAssembling) {
        currentFormationKey = gesture;
    }

    // Snapshot current particle state as the "from" state for smooth transitions
    const currentPositions = new Float32Array(geometry.attributes.position.array);
    const currentColors = new Float32Array(geometry.attributes.color.array);

    // Determine target arrays
    let targetPositions, targetColors;
    if (isAssembling && formations[gesture]) {
        targetPositions = formations[gesture].positions;
        targetColors = formations[gesture].colors;
    } else {
        targetPositions = scatteredPositions;
        targetColors = scatteredColors;
    }

    // Reset progress and tween
    const tweenObj = { val: 0 };

    gsap.killTweensOf(progressObj);
    progressObj = tweenObj;

    gsap.to(tweenObj, {
        val: 1,
        duration: 2.5,
        ease: 'power4.inOut',
        onUpdate: () => {
            const p = tweenObj.val;
            const pos = geometry.attributes.position.array;
            const col = geometry.attributes.color.array;

            // Vortex spiral during interpolation
            const spiralDir = isAssembling ? 1 : -1;
            const spiral = p * Math.PI * 4 * spiralDir;

            for (let i = 0; i < NUM_PARTICLES; i++) {
                const ix = i * 3;
                const iy = ix + 1;
                const iz = ix + 2;

                // Target
                const tx = targetPositions[ix];
                const ty = targetPositions[iy];
                const tz = targetPositions[iz];

                // Apply vortex rotation to target during transition
                const cosS = Math.cos(spiral);
                const sinS = Math.sin(spiral);
                const vx = tx * cosS - tz * sinS;
                const vz = tx * sinS + tz * cosS;

                // Interpolate from current snapshot to vortex-rotated target
                pos[ix] = currentPositions[ix] + (vx - currentPositions[ix]) * p;
                pos[iy] = currentPositions[iy] + (ty - currentPositions[iy]) * p;
                pos[iz] = currentPositions[iz] + (vz - currentPositions[iz]) * p;

                // Interpolate colors
                col[ix] = currentColors[ix] + (targetColors[ix] - currentColors[ix]) * p;
                col[iy] = currentColors[iy] + (targetColors[iy] - currentColors[iy]) * p;
                col[iz] = currentColors[iz] + (targetColors[iz] - currentColors[iz]) * p;
            }

            geometry.attributes.position.needsUpdate = true;
            geometry.attributes.color.needsUpdate = true;
        },
    });
}

// ─────────────────────────────────────────────
//  RESIZE
// ─────────────────────────────────────────────
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
}

// ─────────────────────────────────────────────
//  RENDER LOOP
// ─────────────────────────────────────────────
function animate() {
    requestAnimationFrame(animate);

    // Ambient cosmic drift — only when scattered (neutral), freeze when formed
    if (particles && targetGesture === 'neutral') {
        particles.rotation.y += 0.001;
        particles.rotation.x += 0.0005;
    }

    composer.render();
}
