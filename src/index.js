// checkpoint-worker.js - Complete working version

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

const VALID_TYPES = ['flats', 'houses', 'plots', 'commercial', 'luxury', 'images'];

function getCorsHeaders(origin, isAllowedOrigin) {
    return {
        'Access-Control-Allow-Origin': isAllowedOrigin && origin ? origin : '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
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
        
        // ============================================
        // Helper: Extract and validate type from path
        // ============================================
        const pathParts = url.pathname.split('/').filter(p => p.length > 0);
        
        // ============================================
        // GET /checkpoint/:type - Get checkpoint for specific type
        // ============================================
        if (method === 'GET' && pathParts.length === 2 && pathParts[0] === 'checkpoint') {
            const type = pathParts[1];
            
            // Validate type - return 400 for invalid types
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
        // POST /checkpoint/:type - Save checkpoint
        // ============================================
        if (method === 'POST' && pathParts.length === 2 && pathParts[0] === 'checkpoint') {
            const type = pathParts[1];
            
            // Validate type - return 400 for invalid types
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
        // DELETE /checkpoint/:type - Delete checkpoint
        // ============================================
        if (method === 'DELETE' && pathParts.length === 2 && pathParts[0] === 'checkpoint') {
            const type = pathParts[1];
            
            // Validate type - return 400 for invalid types
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
        // GET /checkpoints - List all checkpoints
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
                            updatedAt: data.updatedAt,
                            itemCount: data.downloadedUrls?.length || data.properties?.length || 'unknown',
                            requestId: data.requestId
                        };
                    }
                }
                
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
        // GET /health - Health check
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
                worker: 'checkpoint-worker',
                kvStatus: kvStatus,
                kvLatencyMs: kvLatency,
                checkpointCount: checkpointCount,
                allowedOrigins: ALLOWED_ORIGINS.length,
                validTypes: VALID_TYPES,
                timestamp: new Date().toISOString(),
                requestId
            }), { status: 200, headers: corsHeaders });
        }
        
        // ============================================
        // GET /cors-test - Test CORS configuration
        // ============================================
        if (method === 'GET' && pathParts.length === 1 && pathParts[0] === 'cors-test') {
            // For local testing, return the actual origin that was used
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
                'GET  /checkpoint/:type',
                'POST /checkpoint/:type (requires API key)',
                'DELETE /checkpoint/:type (requires API key)',
                'GET  /checkpoints'
            ],
            requestId
        }), { status: 404, headers: corsHeaders });
    }
};