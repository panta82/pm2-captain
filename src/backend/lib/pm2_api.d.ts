// PM2 ships types only for its package entry. Captain loads the API class
// directly; see loadPm2Api() in pm2_client.ts.
declare module 'pm2/lib/API.js' {
  const API: new (options: { pm2_home: string; daemon_mode: boolean }) => unknown;
  export default API;
}
