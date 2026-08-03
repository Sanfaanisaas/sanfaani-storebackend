const email = 'limit-test@example.com';
console.log(`Testing rate limit for ${email}`);

async function test() {
  for(let i=1; i<=12; i++) {
    const res = await fetch('http://localhost:5000/api/auth/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({email, password: 'password123'})
    });
    console.log(`Attempt ${i}: ${res.status}`);
    if (res.status === 429) {
      const data = await res.json();
      console.log('429 Triggered:', data.message);
      break;
    }
  }
}

test();
