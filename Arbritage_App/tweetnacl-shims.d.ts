declare module 'tweetnacl' {
  const nacl: any;
  export default nacl;
}

declare module 'tweetnacl-util' {
  export const decodeBase64: (s: string) => Uint8Array;
  export const encodeBase64: (b: Uint8Array) => string;
}
