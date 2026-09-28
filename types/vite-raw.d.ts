declare module '*?raw' {
  const content: string;
  export default content;
}

declare const __DEV_AUTOMATION__: boolean;
declare module 'virtual:development-journal' {
  const content: string;
  export default content;
}
