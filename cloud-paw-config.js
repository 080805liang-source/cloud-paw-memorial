const cloudPawChinaHost = /(^|\.)tcloudbaseapp\.com$|(^|\.)app\.tcloudbase\.com$/.test(window.location.hostname);
window.CLOUD_PAW_API_URL = cloudPawChinaHost
  ? '/api'
  : 'https://cloud-paw-vip-api.cloud-paw-vip-080805liang.workers.dev';
