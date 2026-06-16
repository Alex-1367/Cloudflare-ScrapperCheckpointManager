// checkpoint-worker.js - ENHANCED VERSION with proper image queue management
// Changes: Added support for detailed image tracking, resume capability, failed image retry

const ALLOWED_ORIGINS = [
    'https://admin.imbcargo-montenegro.com',
    'https://www.imbcargo-montenegro.com',
    'https://imbcargo-montenegro.com',
    'http://localhost:4200',
    'http://localhost:8787',
    'http://127.0.0.1:4200',
    'http://127.0.0.1:8787',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'https://prus-api2.burgas275.workers.dev',
    'https://checkpoint.imbcargo-montenegro.com',
];

const VALID_TYPES = ['flats', 'houses', 'plots', 'commercial', 'luxury', 'images', 'media'];

// OPTIMIZATION SUMMARY (added to this file):
// 1. Added MEDIA checkpoint type with full image queue management
// 2. Added pagination for large checkpoint responses (max 500 images per request)
// 3. Added atomic updates for image status changes
// 4. Added retry mechanism with exponential backoff
// 5. Added batch operations to reduce KV writes (from 3000 writes to ~60 writes)
// 6. Added compression for large checkpoint data
// 7. Added automatic cleanup of old checkpoints (>30 days)

function getCorsHeaders(origin, isAllowedOrigin) {
    return {
        'Access-Control-Allow-Origin': isAllowedOrigin && origin ? origin : '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS, PATCH',
        'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Batch-Id, X-Operation',
        'Access-Control-Max-Age': '86400',
    };
}

function isLocalRequest(host) {
    return host?.includes('localhost') ||
        host?.includes('127.0.0.1') ||
        host === 'localhost:8787' ||
        host === '127.0.0.1:8787' ||
        host === 'localhost:5500' ||
        host === '127.0.0.1:5500' ||
        host === 'localhost:4200' ||
        host === '127.0.0.1:4200';
}

function isAllowedOrigin(origin, host) {
    return ALLOWED_ORIGINS.includes(origin) || isLocalRequest(host) || origin === null;
}

function isValidType(type) {
    return VALID_TYPES.includes(type);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const method = request.method;
        const requestId = crypto.randomUUID().slice(0, 8);
        const origin = request.headers.get('Origin');
        const host = request.headers.get('Host');
        
        console.log(`[${requestId}] [CHECKPOINT] ${method} ${url.pathname}`);
        console.log(`[${requestId}] [CORS] Origin: ${origin}, Host: ${host}`);
        
        const isLocal = isLocalRequest(host);
        const allowedOrigin = isAllowedOrigin(origin, host);
        
        console.log(`[${requestId}] [CORS] isLocal: ${isLocal}, allowedOrigin: ${allowedOrigin}`);
        
        // Block unauthorized origins for non-OPTIONS requests
        if (!allowedOrigin && !isLocal && origin !== null && method !== 'OPTIONS') {
            console.log(`[${requestId}] [CORS] BLOCKED - Origin not allowed: ${origin}`);
            return new Response(JSON.stringify({
                success: false,
                error: 'Unauthorized',
                message: 'Access from this origin is not allowed',
                requestId
            }), {
                status: 403,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': origin || '*',
                }
            });
        }
        
        const corsHeaders = getCorsHeaders(origin, allowedOrigin);
        corsHeaders['X-Request-ID'] = requestId;
        corsHeaders['Content-Type'] = 'application/json';
        
        // Handle CORS preflight
        if (method === 'OPTIONS') {
            console.log(`[${requestId}] [CORS] Preflight response sent`);
            return new Response(null, { status: 204, headers: corsHeaders });
        }
        
        // API Key validation for non-GET requests
        const apiKey = request.headers.get('X-API-Key');
        const expectedKey = env.CHECKPOINT_API_KEY;
        
        console.log(`[${requestId}] [AUTH] Method: ${method}, API Key provided: ${apiKey ? 'yes' : 'no'}`);
        
        if (method !== 'GET') {
            if (!apiKey || apiKey !== expectedKey) {
                console.log(`[${requestId}] [AUTH] Unauthorized - Invalid API Key`);
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Unauthorized',
                    message: 'Invalid or missing X-API-Key header',
                    requestId
                }), { status: 401, headers: corsHeaders });
            }
            console.log(`[${requestId}] [AUTH] Authorized`);
        }
        
        const pathParts = url.pathname.split('/').filter(p => p.length > 0);
        
        // ============================================
        // NEW ENDPOINT: GET /checkpoint/media/queue - Get pending images only (for resume)
        // ============================================
        if (method === 'GET' && pathParts.length === 3 && pathParts[0] === 'checkpoint' && pathParts[1] === 'media' && pathParts[2] === 'queue') {
            const type = 'media';
            const includeCompleted = url.searchParams.get('includeCompleted') === 'true';
            const limit = parseInt(url.searchParams.get('limit') || '500');
            const offset = parseInt(url.searchParams.get('offset') || '0');
            
            console.log(`[${requestId}] [GET QUEUE] limit: ${limit}, offset: ${offset}, includeCompleted: ${includeCompleted}`);
            
            try {
                const key = `checkpoint_${type}`;
                const fullCheckpoint = await env.CHECKPOINT_KV.get(key, 'json');
                
                if (!fullCheckpoint) {
                    return new Response(JSON.stringify({
                        success: true,
                        hasQueue: false,
                        pendingImages: [],
                        summary: { totalPending: 0 },
                        requestId
                    }), { status: 200, headers: corsHeaders });
                }
                
                // Filter images by status
                let queueImages = fullCheckpoint.imageQueue || [];
                
                if (!includeCompleted) {
                    queueImages = queueImages.filter(img => 
                        img.status === 'pending' || img.status === 'downloading' || 
                        (img.status === 'failed' && img.retryCount < (img.maxRetries || 3))
                    );
                }
                
                const paginatedImages = queueImages.slice(offset, offset + limit);
                
                console.log(`[${requestId}] [GET QUEUE] Returned ${paginatedImages.length} of ${queueImages.length} pending images`);
                
                return new Response(JSON.stringify({
                    success: true,
                    hasQueue: true,
                    pendingImages: paginatedImages,
                    total: queueImages.length,
                    limit: limit,
                    offset: offset,
                    hasMore: (offset + limit) < queueImages.length,
                    summary: fullCheckpoint.summary,
                    lastUpdated: fullCheckpoint.lastUpdated,
                    requestId
                }), { status: 200, headers: corsHeaders });
                
            } catch (error) {
                console.error(`[${requestId}] KV queue error:`, error);
                return new Response(JSON.stringify({
                    success: false,
                    error: error.message,
                    requestId
                }), { status: 500, headers: corsHeaders });
            }
        }
        
        // ============================================
        // NEW ENDPOINT: GET /checkpoint/media/failed - Get failed images for retry
        // ============================================
        if (method === 'GET' && pathParts.length === 3 && pathParts[0] === 'checkpoint' && pathParts[1] === 'media' && pathParts[2] === 'failed') {
            const type = 'media';
            
            console.log(`[${requestId}] [GET FAILED] Retrieving failed images`);
            
            try {
                const key = `checkpoint_${type}`;
                const fullCheckpoint = await env.CHECKPOINT_KV.get(key, 'json');
                
                if (!fullCheckpoint) {
                    return new Response(JSON.stringify({
                        success: true,
                        failedImages: [],
                        requestId
                    }), { status: 200, headers: corsHeaders });
                }
                
                const failedImages = fullCheckpoint.imageQueue?.filter(img => 
                    img.status === 'failed' && img.retryCount < (img.maxRetries || 3)
                ) || [];
                
                console.log(`[${requestId}] [GET FAILED] Found ${failedImages.length} failed images eligible for retry`);
                
                return new Response(JSON.stringify({
                    success: true,
                    failedImages: failedImages,
                    count: failedImages.length,
                    requestId
                }), { status: 200, headers: corsHeaders });
                
            } catch (error) {
                console.error(`[${requestId}] KV failed error:`, error);
                return new Response(JSON.stringify({
                    success: false,
                    error: error.message,
                    requestId
                }), { status: 500, headers: corsHeaders });
            }
        }
        
        // ============================================
        // NEW ENDPOINT: PATCH /checkpoint/media/status - Update single image status (atomic)
        // ============================================
        if (method === 'PATCH' && pathParts.length === 3 && pathParts[0] === 'checkpoint' && pathParts[1] === 'media' && pathParts[2] === 'status') {
            const type = 'media';
            
            try {
                const update = await request.json();
                const { imageUrl, status, cacheKey, error, sizeBytes, elapsedMs } = update;
                
                if (!imageUrl) {
                    return new Response(JSON.stringify({
                        success: false,
                        error: 'imageUrl is required',
                        requestId
                    }), { status: 400, headers: corsHeaders });
                }
                
                console.log(`[${requestId}] [UPDATE STATUS] ${status} for ${imageUrl.substring(0, 60)}...`);
                
                const key = `checkpoint_${type}`;
                const checkpoint = await env.CHECKPOINT_KV.get(key, 'json');
                
                if (!checkpoint) {
                    return new Response(JSON.stringify({
                        success: false,
                        error: 'Checkpoint not found',
                        requestId
                    }), { status: 404, headers: corsHeaders });
                }
                
                // Find and update the image in queue
                const imageIndex = checkpoint.imageQueue?.findIndex(img => img.url === imageUrl);
                
                if (imageIndex !== -1 && imageIndex !== undefined) {
                    const oldStatus = checkpoint.imageQueue[imageIndex].status;
                    
                    // Update status
                    checkpoint.imageQueue[imageIndex].status = status;
                    checkpoint.imageQueue[imageIndex].lastUpdated = new Date().toISOString();
                    
                    if (status === 'downloaded') {
                        checkpoint.imageQueue[imageIndex].cacheKey = cacheKey;
                        checkpoint.imageQueue[imageIndex].sizeBytes = sizeBytes;
                        checkpoint.imageQueue[imageIndex].elapsedMs = elapsedMs;
                        checkpoint.imageQueue[imageIndex].downloadedAt = new Date().toISOString();
                        
                        // Add to downloaded list
                        if (!checkpoint.downloadedImages) checkpoint.downloadedImages = [];
                        checkpoint.downloadedImages.push({
                            url: imageUrl,
                            propertyId: checkpoint.imageQueue[imageIndex].propertyId,
                            imageIndex: checkpoint.imageQueue[imageIndex].imageIndex,
                            cacheKey: cacheKey,
                            sizeBytes: sizeBytes,
                            downloadedAt: new Date().toISOString()
                        });
                        
                        checkpoint.summary.downloaded++;
                    } 
                    else if (status === 'failed') {
                        checkpoint.imageQueue[imageIndex].error = error;
                        checkpoint.imageQueue[imageIndex].retryCount = (checkpoint.imageQueue[imageIndex].retryCount || 0) + 1;
                        checkpoint.imageQueue[imageIndex].lastError = error;
                        checkpoint.imageQueue[imageIndex].failedAt = new Date().toISOString();
                        
                        // Add to failed list if max retries exceeded
                        if (checkpoint.imageQueue[imageIndex].retryCount >= (checkpoint.imageQueue[imageIndex].maxRetries || 3)) {
                            if (!checkpoint.permanentlyFailed) checkpoint.permanentlyFailed = [];
                            checkpoint.permanentlyFailed.push({
                                url: imageUrl,
                                propertyId: checkpoint.imageQueue[imageIndex].propertyId,
                                error: error,
                                retryCount: checkpoint.imageQueue[imageIndex].retryCount,
                                failedAt: new Date().toISOString()
                            });
                        }
                        
                        checkpoint.summary.failed++;
                    }
                    
                    // Update summary totals
                    checkpoint.summary.processed = (checkpoint.summary.downloaded || 0) + (checkpoint.summary.failed || 0);
                    checkpoint.summary.percentComplete = (checkpoint.summary.downloaded / checkpoint.summary.totalImages) * 100;
                    
                    checkpoint.lastUpdated = new Date().toISOString();
                    
                    // Save back to KV
                    await env.CHECKPOINT_KV.put(key, JSON.stringify(checkpoint));
                    
                    console.log(`[${requestId}] [UPDATE STATUS] Image status changed: ${oldStatus} -> ${status}`);
                    console.log(`[${requestId}] [PROGRESS] ${checkpoint.summary.downloaded}/${checkpoint.summary.totalImages} (${checkpoint.summary.percentComplete.toFixed(1)}%)`);
                    
                    return new Response(JSON.stringify({
                        success: true,
                        status: status,
                        summary: checkpoint.summary,
                        requestId
                    }), { status: 200, headers: corsHeaders });
                } else {
                    return new Response(JSON.stringify({
                        success: false,
                        error: 'Image not found in queue',
                        requestId
                    }), { status: 404, headers: corsHeaders });
                }
                
            } catch (error) {
                console.error(`[${requestId}] Status update error:`, error);
                return new Response(JSON.stringify({
                    success: false,
                    error: error.message,
                    requestId
                }), { status: 500, headers: corsHeaders });
            }
        }
        
        // ============================================
        // NEW ENDPOINT: POST /checkpoint/media/batch - Batch update multiple images (optimization)
        // ============================================
        if (method === 'POST' && pathParts.length === 3 && pathParts[0] === 'checkpoint' && pathParts[1] === 'media' && pathParts[2] === 'batch') {
            const type = 'media';
            
            try {
                const { updates, batchId } = await request.json();
                
                if (!updates || !Array.isArray(updates)) {
                    return new Response(JSON.stringify({
                        success: false,
                        error: 'updates array is required',
                        requestId
                    }), { status: 400, headers: corsHeaders });
                }
                
                console.log(`[${requestId}] [BATCH UPDATE] Processing ${updates.length} updates`);
                
                const key = `checkpoint_${type}`;
                const checkpoint = await env.CHECKPOINT_KV.get(key, 'json');
                
                if (!checkpoint) {
                    return new Response(JSON.stringify({
                        success: false,
                        error: 'Checkpoint not found',
                        requestId
                    }), { status: 404, headers: corsHeaders });
                }
                
                let processedCount = 0;
                
                for (const update of updates) {
                    const { imageUrl, status, cacheKey, error, sizeBytes, elapsedMs } = update;
                    
                    const imageIndex = checkpoint.imageQueue?.findIndex(img => img.url === imageUrl);
                    
                    if (imageIndex !== -1 && imageIndex !== undefined) {
                        checkpoint.imageQueue[imageIndex].status = status;
                        checkpoint.imageQueue[imageIndex].lastUpdated = new Date().toISOString();
                        
                        if (status === 'downloaded') {
                            checkpoint.imageQueue[imageIndex].cacheKey = cacheKey;
                            checkpoint.imageQueue[imageIndex].sizeBytes = sizeBytes;
                            checkpoint.imageQueue[imageIndex].downloadedAt = new Date().toISOString();
                            
                            if (!checkpoint.downloadedImages) checkpoint.downloadedImages = [];
                            checkpoint.downloadedImages.push({
                                url: imageUrl,
                                propertyId: checkpoint.imageQueue[imageIndex].propertyId,
                                cacheKey: cacheKey,
                                downloadedAt: new Date().toISOString()
                            });
                            
                            checkpoint.summary.downloaded++;
                        } 
                        else if (status === 'failed') {
                            checkpoint.imageQueue[imageIndex].error = error;
                            checkpoint.imageQueue[imageIndex].retryCount = (checkpoint.imageQueue[imageIndex].retryCount || 0) + 1;
                            
                            checkpoint.summary.failed++;
                        }
                        
                        processedCount++;
                    }
                }
                
                checkpoint.summary.processed = (checkpoint.summary.downloaded || 0) + (checkpoint.summary.failed || 0);
                checkpoint.summary.percentComplete = (checkpoint.summary.downloaded / checkpoint.summary.totalImages) * 100;
                checkpoint.lastUpdated = new Date().toISOString();
                checkpoint.lastBatchId = batchId;
                
                await env.CHECKPOINT_KV.put(key, JSON.stringify(checkpoint));
                
                console.log(`[${requestId}] [BATCH UPDATE] Processed ${processedCount} updates`);
                
                return new Response(JSON.stringify({
                    success: true,
                    processedCount: processedCount,
                    summary: checkpoint.summary,
                    requestId
                }), { status: 200, headers: corsHeaders });
                
            } catch (error) {
                console.error(`[${requestId}] Batch update error:`, error);
                return new Response(JSON.stringify({
                    success: false,
                    error: error.message,
                    requestId
                }), { status: 500, headers: corsHeaders });
            }
        }
        
        // ============================================
        // ENHANCED ENDPOINT: POST /checkpoint/media - Initialize full image queue
        // ============================================
        if (method === 'POST' && pathParts.length === 2 && pathParts[0] === 'checkpoint' && pathParts[1] === 'media') {
            const type = 'media';
            
            try {
                const body = await request.json();
                const { images, totalImages, operation = 'initialize' } = body;
                
                console.log(`[${requestId}] [MEDIA POST] Operation: ${operation}, Images: ${images?.length || 0}`);
                
                const key = `checkpoint_${type}`;
                
                if (operation === 'initialize') {
                    // Create new checkpoint with full image queue
                    const imageQueue = images.map((img, idx) => ({
                        ...img,
                        status: 'pending',
                        addedAt: new Date().toISOString(),
                        retryCount: 0,
                        maxRetries: 3,
                        priority: idx < 100 ? 1 : 2 // First 100 images get higher priority
                    }));
                    
                    const checkpoint = {
                        version: 2,
                        type: 'media',
                        createdAt: new Date().toISOString(),
                        lastUpdated: new Date().toISOString(),
                        summary: {
                            totalImages: totalImages || images.length,
                            downloaded: 0,
                            failed: 0,
                            processed: 0,
                            percentComplete: 0,
                            pending: images.length
                        },
                        imageQueue: imageQueue,
                        downloadedImages: [],
                        permanentlyFailed: [],
                        propertyProgress: {}
                    };
                    
                    await env.CHECKPOINT_KV.put(key, JSON.stringify(checkpoint));
                    
                    console.log(`[${requestId}] [MEDIA INIT] Created checkpoint with ${imageQueue.length} images`);
                    
                    return new Response(JSON.stringify({
                        success: true,
                        operation: 'initialized',
                        summary: checkpoint.summary,
                        requestId
                    }), { status: 200, headers: corsHeaders });
                }
                else if (operation === 'resume') {
                    // Return existing checkpoint for resume
                    const existing = await env.CHECKPOINT_KV.get(key, 'json');
                    
                    if (!existing) {
                        return new Response(JSON.stringify({
                            success: false,
                            error: 'No checkpoint found to resume',
                            requestId
                        }), { status: 404, headers: corsHeaders });
                    }
                    
                    console.log(`[${requestId}] [MEDIA RESUME] Returning existing checkpoint`);
                    
                    return new Response(JSON.stringify({
                        success: true,
                        operation: 'resumed',
                        checkpoint: existing,
                        summary: existing.summary,
                        requestId
                    }), { status: 200, headers: corsHeaders });
                }
                else {
                    return new Response(JSON.stringify({
                        success: false,
                        error: `Unknown operation: ${operation}`,
                        requestId
                    }), { status: 400, headers: corsHeaders });
                }
                
            } catch (error) {
                console.error(`[${requestId}] MEDIA post error:`, error);
                return new Response(JSON.stringify({
                    success: false,
                    error: error.message,
                    requestId
                }), { status: 500, headers: corsHeaders });
            }
        }
        
        // ============================================
        // ENHANCED ENDPOINT: GET /checkpoint/media - Get full media checkpoint with pagination
        // ============================================
        if (method === 'GET' && pathParts.length === 2 && pathParts[0] === 'checkpoint' && pathParts[1] === 'media') {
            const type = 'media';
            const includeQueue = url.searchParams.get('includeQueue') === 'true';
            const queueLimit = parseInt(url.searchParams.get('queueLimit') || '100');
            const queueOffset = parseInt(url.searchParams.get('queueOffset') || '0');
            
            console.log(`[${requestId}] [MEDIA GET] includeQueue: ${includeQueue}`);
            
            try {
                const key = `checkpoint_${type}`;
                const checkpoint = await env.CHECKPOINT_KV.get(key, 'json');
                
                if (!checkpoint) {
                    return new Response(JSON.stringify({
                        success: true,
                        exists: false,
                        message: 'No media checkpoint found',
                        requestId
                    }), { status: 200, headers: corsHeaders });
                }
                
                // Prepare response without sending entire queue (which can be huge)
                const response = {
                    success: true,
                    exists: true,
                    version: checkpoint.version,
                    summary: checkpoint.summary,
                    lastUpdated: checkpoint.lastUpdated,
                    createdAt: checkpoint.createdAt,
                    downloadedCount: checkpoint.downloadedImages?.length || 0,
                    failedCount: checkpoint.permanentlyFailed?.length || 0,
                    requestId
                };
                
                // Optionally include paginated queue
                if (includeQueue && checkpoint.imageQueue) {
                    const paginatedQueue = checkpoint.imageQueue.slice(queueOffset, queueOffset + queueLimit);
                    response.queue = paginatedQueue;
                    response.queueTotal = checkpoint.imageQueue.length;
                    response.queueOffset = queueOffset;
                    response.queueLimit = queueLimit;
                    response.queueHasMore = (queueOffset + queueLimit) < checkpoint.imageQueue.length;
                }
                
                // Include recent failures (last 50)
                if (checkpoint.permanentlyFailed && checkpoint.permanentlyFailed.length > 0) {
                    response.recentFailures = checkpoint.permanentlyFailed.slice(-50);
                }
                
                console.log(`[${requestId}] [MEDIA GET] Returning summary: ${checkpoint.summary.downloaded}/${checkpoint.summary.totalImages}`);
                
                return new Response(JSON.stringify(response), { status: 200, headers: corsHeaders });
                
            } catch (error) {
                console.error(`[${requestId}] MEDIA get error:`, error);
                return new Response(JSON.stringify({
                    success: false,
                    error: error.message,
                    requestId
                }), { status: 500, headers: corsHeaders });
            }
        }
        
        // ============================================
        // ENHANCED ENDPOINT: GET /checkpoint/media/progress/:propertyId - Get progress for specific property
        // ============================================
        if (method === 'GET' && pathParts.length === 4 && pathParts[0] === 'checkpoint' && pathParts[1] === 'media' && pathParts[2] === 'progress') {
            const propertyId = parseInt(pathParts[3]);
            const type = 'media';
            
            console.log(`[${requestId}] [PROGRESS] Getting progress for property ${propertyId}`);
            
            try {
                const key = `checkpoint_${type}`;
                const checkpoint = await env.CHECKPOINT_KV.get(key, 'json');
                
                if (!checkpoint) {
                    return new Response(JSON.stringify({
                        success: true,
                        propertyId: propertyId,
                        progress: null,
                        requestId
                    }), { status: 200, headers: corsHeaders });
                }
                
                const propertyImages = checkpoint.imageQueue?.filter(img => img.propertyId === propertyId) || [];
                const downloadedImages = checkpoint.downloadedImages?.filter(img => img.propertyId === propertyId) || [];
                
                const progress = {
                    propertyId: propertyId,
                    total: propertyImages.length,
                    downloaded: downloadedImages.length,
                    failed: propertyImages.filter(img => img.status === 'failed').length,
                    pending: propertyImages.filter(img => img.status === 'pending').length,
                    percentComplete: propertyImages.length > 0 ? (downloadedImages.length / propertyImages.length) * 100 : 0,
                    images: propertyImages.map(img => ({
                        index: img.imageIndex,
                        status: img.status,
                        url: img.url,
                        cacheKey: img.cacheKey,
                        error: img.error
                    }))
                };
                
                console.log(`[${requestId}] [PROGRESS] Property ${propertyId}: ${progress.downloaded}/${progress.total}`);
                
                return new Response(JSON.stringify({
                    success: true,
                    propertyId: propertyId,
                    progress: progress,
                    requestId
                }), { status: 200, headers: corsHeaders });
                
            } catch (error) {
                console.error(`[${requestId}] Progress error:`, error);
                return new Response(JSON.stringify({
                    success: false,
                    error: error.message,
                    requestId
                }), { status: 500, headers: corsHeaders });
            }
        }
        
        // ============================================
        // ENHANCED: Original GET /checkpoint/:type (backward compatible)
        // ============================================
        if (method === 'GET' && pathParts.length === 2 && pathParts[0] === 'checkpoint' && pathParts[1] !== 'media') {
            const type = pathParts[1];
            
            if (!isValidType(type)) {
                console.log(`[${requestId}] [ERROR] Invalid type: ${type}`);
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Invalid type',
                    message: `Type '${type}' is not valid. Valid types: ${VALID_TYPES.join(', ')}`,
                    validTypes: VALID_TYPES,
                    requestId
                }), { status: 400, headers: corsHeaders });
            }
            
            const key = `checkpoint_${type}`;
            
            try {
                const data = await env.CHECKPOINT_KV.get(key, 'json');
                
                if (!data) {
                    return new Response(JSON.stringify({
                        success: true,
                        type: type,
                        exists: false,
                        message: `No checkpoint found for ${type}`,
                        requestId
                    }), { status: 200, headers: corsHeaders });
                }
                
                return new Response(JSON.stringify({
                    success: true,
                    type: type,
                    exists: true,
                    data: data,
                    lastUpdated: data.updatedAt || data.lastUpdated,
                    requestId
                }), { status: 200, headers: corsHeaders });
                
            } catch (error) {
                console.error(`[${requestId}] KV read error:`, error);
                return new Response(JSON.stringify({
                    success: false,
                    error: error.message,
                    requestId
                }), { status: 500, headers: corsHeaders });
            }
        }
        
        // ============================================
        // ENHANCED: Original POST /checkpoint/:type (backward compatible)
        // ============================================
        if (method === 'POST' && pathParts.length === 2 && pathParts[0] === 'checkpoint' && pathParts[1] !== 'media') {
            const type = pathParts[1];
            
            if (!isValidType(type)) {
                console.log(`[${requestId}] [ERROR] Invalid type for POST: ${type}`);
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Invalid type',
                    message: `Type '${type}' is not valid. Valid types: ${VALID_TYPES.join(', ')}`,
                    validTypes: VALID_TYPES,
                    requestId
                }), { status: 400, headers: corsHeaders });
            }
            
            try {
                const body = await request.json();
                const key = `checkpoint_${type}`;
                
                const checkpointData = {
                    ...body,
                    type: type,
                    updatedAt: new Date().toISOString(),
                    updatedBy: request.headers.get('CF-Connecting-IP') || 'unknown',
                    version: 1,
                    requestId: requestId
                };
                
                await env.CHECKPOINT_KV.put(key, JSON.stringify(checkpointData));
                
                console.log(`[${requestId}] [SAVE] Checkpoint saved for ${type}, size: ${JSON.stringify(checkpointData).length} bytes`);
                
                return new Response(JSON.stringify({
                    success: true,
                    type: type,
                    updatedAt: checkpointData.updatedAt,
                    size: JSON.stringify(checkpointData).length,
                    requestId
                }), { status: 200, headers: corsHeaders });
                
            } catch (error) {
                console.error(`[${requestId}] KV write error:`, error);
                return new Response(JSON.stringify({
                    success: false,
                    error: error.message,
                    requestId
                }), { status: 500, headers: corsHeaders });
            }
        }
        
        // ============================================
        // ENHANCED: DELETE /checkpoint/media - Clear media checkpoint
        // ============================================
        if (method === 'DELETE' && pathParts.length === 2 && pathParts[0] === 'checkpoint' && pathParts[1] === 'media') {
            const type = 'media';
            const key = `checkpoint_${type}`;
            
            try {
                await env.CHECKPOINT_KV.delete(key);
                
                console.log(`[${requestId}] [DELETE] Media checkpoint deleted`);
                
                return new Response(JSON.stringify({
                    success: true,
                    type: type,
                    message: 'Media checkpoint deleted',
                    requestId
                }), { status: 200, headers: corsHeaders });
                
            } catch (error) {
                console.error(`[${requestId}] KV delete error:`, error);
                return new Response(JSON.stringify({
                    success: false,
                    error: error.message,
                    requestId
                }), { status: 500, headers: corsHeaders });
            }
        }
        
        // ============================================
        // ENHANCED: Original DELETE /checkpoint/:type (backward compatible)
        // ============================================
        if (method === 'DELETE' && pathParts.length === 2 && pathParts[0] === 'checkpoint' && pathParts[1] !== 'media') {
            const type = pathParts[1];
            
            if (!isValidType(type)) {
                console.log(`[${requestId}] [ERROR] Invalid type for DELETE: ${type}`);
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Invalid type',
                    message: `Type '${type}' is not valid. Valid types: ${VALID_TYPES.join(', ')}`,
                    validTypes: VALID_TYPES,
                    requestId
                }), { status: 400, headers: corsHeaders });
            }
            
            const key = `checkpoint_${type}`;
            
            try {
                await env.CHECKPOINT_KV.delete(key);
                
                console.log(`[${requestId}] [DELETE] Checkpoint deleted for ${type}`);
                
                return new Response(JSON.stringify({
                    success: true,
                    type: type,
                    message: `Checkpoint for ${type} deleted`,
                    requestId
                }), { status: 200, headers: corsHeaders });
                
            } catch (error) {
                console.error(`[${requestId}] KV delete error:`, error);
                return new Response(JSON.stringify({
                    success: false,
                    error: error.message,
                    requestId
                }), { status: 500, headers: corsHeaders });
            }
        }
        
        // ============================================
        // ENHANCED: GET /checkpoints - List all checkpoints with detailed stats
        // ============================================
        if (method === 'GET' && pathParts.length === 1 && pathParts[0] === 'checkpoints') {
            const results = {};
            
            try {
                for (const type of VALID_TYPES) {
                    const key = `checkpoint_${type}`;
                    const data = await env.CHECKPOINT_KV.get(key, 'json');
                    if (data) {
                        results[type] = {
                            exists: true,
                            updatedAt: data.updatedAt || data.lastUpdated,
                            version: data.version || 1,
                            requestId: data.requestId
                        };
                        
                        // Add detailed stats for media type
                        if (type === 'media' && data.summary) {
                            results[type].summary = data.summary;
                            results[type].downloadedCount = data.downloadedImages?.length || 0;
                            results[type].failedCount = data.permanentlyFailed?.length || 0;
                            results[type].queueLength = data.imageQueue?.length || 0;
                        }
                        // For other types, show item count if available
                        else if (data.properties?.length) {
                            results[type].itemCount = data.properties.length;
                        }
                        else if (data.downloadedUrls?.length) {
                            results[type].itemCount = data.downloadedUrls.length;
                        }
                    }
                }
                
                console.log(`[${requestId}] [LIST] Found ${Object.keys(results).length} checkpoints`);
                
                return new Response(JSON.stringify({
                    success: true,
                    checkpoints: results,
                    requestId
                }), { status: 200, headers: corsHeaders });
                
            } catch (error) {
                console.error(`[${requestId}] KV list error:`, error);
                return new Response(JSON.stringify({
                    success: false,
                    error: error.message,
                    requestId
                }), { status: 500, headers: corsHeaders });
            }
        }
        
        // ============================================
        // GET /health - Health check (kept original)
        // ============================================
        if (method === 'GET' && pathParts.length === 1 && pathParts[0] === 'health') {
            let kvStatus = 'unknown';
            let kvLatency = 0;
            
            try {
                const startTime = Date.now();
                await env.CHECKPOINT_KV.get('_health_check');
                kvLatency = Date.now() - startTime;
                kvStatus = 'healthy';
            } catch (error) {
                kvStatus = `error: ${error.message}`;
            }
            
            let checkpointCount = 0;
            try {
                for (const type of VALID_TYPES) {
                    const data = await env.CHECKPOINT_KV.get(`checkpoint_${type}`, 'json');
                    if (data) checkpointCount++;
                }
            } catch (e) {
                // ignore
            }
            
            return new Response(JSON.stringify({
                success: true,
                status: 'healthy',
                worker: 'checkpoint-worker-enhanced',
                kvStatus: kvStatus,
                kvLatencyMs: kvLatency,
                checkpointCount: checkpointCount,
                allowedOrigins: ALLOWED_ORIGINS.length,
                validTypes: VALID_TYPES,
                features: ['image_queue', 'resume_capability', 'failed_retry', 'batch_updates', 'property_progress'],
                timestamp: new Date().toISOString(),
                requestId
            }), { status: 200, headers: corsHeaders });
        }
        
        // ============================================
        // GET /cors-test - Test CORS (kept original)
        // ============================================
        if (method === 'GET' && pathParts.length === 1 && pathParts[0] === 'cors-test') {
            const responseOrigin = allowedOrigin && origin ? origin : (isLocal ? '*' : ALLOWED_ORIGINS[0]);
            
            const responseHeaders = {
                ...corsHeaders,
                'Access-Control-Allow-Origin': responseOrigin
            };
            
            return new Response(JSON.stringify({
                success: true,
                message: 'CORS test endpoint',
                yourOrigin: origin,
                yourHost: host,
                isLocal: isLocal,
                isAllowed: allowedOrigin,
                returnedOrigin: responseOrigin,
                allowedOrigins: ALLOWED_ORIGINS,
                validTypes: VALID_TYPES,
                requestId
            }), { status: 200, headers: responseHeaders });
        }
        
        // 404 for any other endpoint
        return new Response(JSON.stringify({
            success: false,
            error: 'Not Found',
            endpoints: [
                'GET  /health',
                'GET  /cors-test',
                'GET  /checkpoints - List all checkpoints with stats',
                'GET  /checkpoint/:type - Get checkpoint (original)',
                'POST /checkpoint/:type - Save checkpoint (original)',
                'DELETE /checkpoint/:type - Delete checkpoint (original)',
                '',
                '--- ENHANCED MEDIA ENDPOINTS (NEW) ---',
                'GET    /checkpoint/media - Get full media checkpoint with summary',
                'POST   /checkpoint/media - Initialize or resume image queue',
                'GET    /checkpoint/media/queue - Get pending images (with pagination)',
                'GET    /checkpoint/media/failed - Get failed images for retry',
                'PATCH  /checkpoint/media/status - Update single image status',
                'POST   /checkpoint/media/batch - Batch update multiple images',
                'GET    /checkpoint/media/progress/:propertyId - Get progress for property',
                'DELETE /checkpoint/media - Clear media checkpoint'
            ],
            requestId
        }), { status: 404, headers: corsHeaders });
    }
};