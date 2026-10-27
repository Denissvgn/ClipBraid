import React, { useEffect, useRef, useState } from "react";
import { useModalDialog } from "./useModalDialog";

export function ProjectOpenPrompt({filename,onCancel,onOpen,onSave}:{filename:string;onCancel():void;onOpen():void;onSave():Promise<boolean>}) {
  const dialog=useModalDialog(),[saving,setSaving]=useState(false),[error,setError]=useState("");
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
  const save=async()=>{
    setSaving(true);setError("");
    try{if(!await onSave()&&alive.current)setError("The project backup was not acknowledged. Your current edits are still open. Try again or cancel opening.")}
    catch{if(alive.current)setError("Could not save the project backup. Your current edits are still open.")}
    finally{if(alive.current)setSaving(false)}
  };
  return <dialog ref={dialog} className="intro-dialog" aria-labelledby="open-project-title" onCancel={event=>{event.preventDefault();onCancel()}}>
    <h2 id="open-project-title">Open another project?</h2>
    <p>Your current edits have not been saved to a project file. Local autosave is browser storage and can be cleared.</p>
    <p>Selected file: {filename}</p>
    {error&&<p role="alert">{error}</p>}
    <div className="feedback-actions">
      <button className="button primary" disabled={saving} onClick={()=>void save()}>Save current project first</button>
      <button className="button secondary" disabled={saving} onClick={onOpen}>Open without saving</button>
      <button className="button secondary" onClick={onCancel} autoFocus>Cancel opening</button>
    </div>
  </dialog>;
}
