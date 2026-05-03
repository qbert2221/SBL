const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

// Simple in-memory storage for purchased users (in production, use a database)
const purchasedUsers = new Set();

const server = http.createServer((req, res) => {
  // Handle Gumroad webhook
  if (req.url === '/gumroad-webhook' && req.method === 'POST') {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        // Gumroad sends application/x-www-form-urlencoded, not JSON
        const params = new URLSearchParams(body);
        const data = Object.fromEntries(params.entries());
        
        // Gumroad sends sale data
        if (data.sale_id && data.email) {
          console.log('New purchase:', data.email);
          purchasedUsers.add(data.email.toLowerCase());
          
          // In production, you would:
          // 1. Store in database
          // 2. Send magic link email via EmailJS
          // 3. Grant access token
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid data' }));
        }
      } catch (error) {
        console.error('Webhook error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server error' }));
      }
    });
    return;
  }
  
  // Stripe publishable key (safe to expose)
  if (req.url === '/api/stripe-config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' }));
    return;
  }

  // Create Stripe PaymentIntent
  if (req.url === '/create-payment-intent' && req.method === 'POST') {
    if (!stripe) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'STRIPE_SECRET_KEY not configured on server.' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const { email, name } = JSON.parse(body);
        const paymentIntent = await stripe.paymentIntents.create({
          amount: 9700,
          currency: 'usd',
          receipt_email: email,
          metadata: { name: name || '', email: email || '' },
          automatic_payment_methods: { enabled: true },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ clientSecret: paymentIntent.client_secret }));
      } catch (err) {
        console.error('PaymentIntent error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Stripe webhook
  if (req.url === '/stripe-webhook' && req.method === 'POST') {
    if (!stripe) { res.writeHead(500); res.end('Stripe not configured'); return; }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      const sig = req.headers['stripe-signature'];
      let event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
      } catch (err) {
        res.writeHead(400);
        res.end(`Webhook Error: ${err.message}`);
        return;
      }
      if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object;
        const email = pi.receipt_email || (pi.metadata && pi.metadata.email);
        if (email) {
          purchasedUsers.add(email.toLowerCase());
          console.log('Stripe payment succeeded for:', email);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    });
    return;
  }

  // Handle check access API
  if (req.url.startsWith('/api/check-access') && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const email = url.searchParams.get('email');
    
    if (email && purchasedUsers.has(email.toLowerCase())) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hasAccess: true }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hasAccess: false }));
    }
    return;
  }
  
  // Serve static files
  let filePath = '.' + req.url;
  if (filePath === './') {
    filePath = './index.html';
  }
  
  const extname = String(path.extname(filePath)).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  
  const contentType = mimeTypes[extname] || 'application/octet-stream';
  
  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 - Not Found</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end('Server Error: ' + error.code);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
