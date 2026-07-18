import { useId } from 'react';
import { FileCheck2, Upload } from 'lucide-react';

import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface FileUploadFieldProps {
    readonly accept: string;
    readonly buttonLabel: string;
    readonly fileName?: string;
    readonly hint: string;
    readonly label: string;
    readonly onFile: (file: File) => void | Promise<void>;
}

export function FileUploadField({ accept, buttonLabel, fileName, hint, label, onFile }: FileUploadFieldProps) {
    const inputId = useId();

    return (
        <div className="grid gap-1.5">
            <Label htmlFor={inputId}>{label}</Label>
            <span className="text-xs text-muted-foreground">{hint}</span>
            <label
                htmlFor={inputId}
                className={cn(
                    'flex min-h-20 cursor-pointer items-center gap-3 rounded-lg border border-dashed bg-background px-4 py-3 transition-colors',
                    'hover:border-foreground/30 hover:bg-muted/30 focus-within:ring-2 focus-within:ring-ring/50',
                )}
            >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sand-100 text-foreground">
                    {fileName ? <FileCheck2 className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
                </span>
                <span className="min-w-0">
                    <span className="block text-sm font-medium">{fileName || buttonLabel}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                        {fileName ? 'Choose another file to replace it' : 'Select a file from this device'}
                    </span>
                </span>
                <input
                    id={inputId}
                    className="sr-only"
                    type="file"
                    accept={accept}
                    onChange={event => {
                        const file = event.target.files?.[0];
                        if (file) void onFile(file);
                        event.target.value = '';
                    }}
                />
            </label>
        </div>
    );
}
