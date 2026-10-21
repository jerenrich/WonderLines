export class MemoryStorage {
  constructor(){this.values=new Map();this.alarm=null;}
  async get(key){return this.values.has(key)?structuredClone(this.values.get(key)):undefined;}
  async put(key,value){this.values.set(key,structuredClone(value));}
  async delete(key){return this.values.delete(key);}
  async list({prefix='',limit=Infinity}={}){return new Map([...this.values].filter(([key])=>key.startsWith(prefix)).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit).map(([key,value])=>[key,structuredClone(value)]));}
  async transaction(callback){return callback(this);}
  async getAlarm(){return this.alarm;}
  async setAlarm(value){this.alarm=value;}
}
