import { getHttp, } from "context";

export class ORMError extends Error {
    public errorCode: string;
    public userMessage: string;
    public statusCode: number;
    public details?: any;

    constructor(
        errorCode: string,
        userMessage: string,
        statusCode = 400,
        details?: any
    ) {
        super(userMessage);

        this.name = errorCode;
        this.errorCode = errorCode;
        this.userMessage = userMessage;
        this.statusCode = statusCode;
        this.details = details;

        const response = getHttp().response;
        response.setStatusCode(statusCode);
        response.setBody({
            resCode: errorCode,
            resMsg: userMessage,
            result: details ?? null,
        });

        Object.setPrototypeOf(this, new.target.prototype);

        const ErrorAny = Error as any;
        if (typeof ErrorAny.captureStackTrace === "function") {
            ErrorAny.captureStackTrace(this, new.target);
        }
    }
}

export class ORMValidationError extends ORMError {
    constructor(details: any) {
        super("ValidationError", "Validation failed", 422, details);
    }
}

export class ORMRequiredFieldError extends ORMError {
    constructor(field: string) {
        super("RequiredFieldError", `${field} is required`, 422, { field });
    }
}

export class ORMNotFoundError extends ORMError {
    constructor(entity: string, criteria?: string) {
        super("NotFoundError", `${entity} not found`, 404, { entity, criteria });
    }
}

export class ORMDuplicateError extends ORMError {
    constructor(field: string, value?: any) {
        super("DuplicateError", `${field} already exists`, 409, { field, value });
    }
}

export class ORMInvalidTypeError extends ORMError {
    constructor(field: string, expected: string, received: string) {
        super("InvalidTypeError", `${field} must be ${expected}`, 422, {
            field,
            expected,
            received,
        });
    }
}