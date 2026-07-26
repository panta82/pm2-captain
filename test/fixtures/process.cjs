let counter = 0;

console.log('captain fixture started');
console.error('captain fixture stderr ready');

setInterval(() => {
  counter += 1;
  console.log(`${new Date().toISOString()} fixture output ${counter}`);
  if (counter % 3 === 0) {
    console.error(`${new Date().toISOString()} fixture error ${counter}`);
  }
}, 500);
