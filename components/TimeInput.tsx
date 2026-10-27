import React,{useEffect,useId,useRef,useState} from "react";

/** Keep incomplete keyboard edits local; commit one validated command on blur
 * or Enter. Escape restores the value without changing project history. */
export function TimeInput({label,value,min,max,onCommit}:{label:string;value:number;min:number;max:number;onCommit:(value:number)=>void}) {
  const id=useId(),[draft,setDraft]=useState(String(value)),[error,setError]=useState("");
  const skipBlur=useRef(false);
  useEffect(()=>{setDraft(String(value));setError("")},[value]);
  const commit=()=>{
    const time=draft.trim()===""?NaN:Number(draft);
    if(!Number.isFinite(time)||time<min-1e-8||time>max+1e-8){
      setError(`Enter a time between ${min.toFixed(2)} and ${max.toFixed(2)} seconds.`);return false;
    }
    try{onCommit(Math.min(max,Math.max(min,time)));setError("");return true}
    catch(cause){setError(cause instanceof Error?cause.message:String(cause));return false}
  };
  return <div className="inspector-section">
    <label htmlFor={id}>{label}</label>
    <input id={id} type="number" inputMode="decimal" step="0.01" min={min} max={max} value={draft}
      aria-invalid={!!error} aria-describedby={error?id+"-error":undefined}
      onChange={event=>{setDraft(event.target.value);setError("")}}
      onBlur={()=>{if(skipBlur.current)skipBlur.current=false;else commit()}}
      onKeyDown={event=>{
        if(event.key==="Escape"){event.stopPropagation();setDraft(String(value));setError("");skipBlur.current=true;event.currentTarget.blur()}
        else if(event.key==="Enter"){event.preventDefault();if(commit()){skipBlur.current=true;event.currentTarget.blur()}}
      }} />
    {error&&<p className="helper-text" id={id+"-error"} role="alert">{error}</p>}
  </div>;
}
